set shell := ["bash", "-euo", "pipefail", "-c"]

# Sessions inherit whatever RUSTUP_TOOLCHAIN their startup environment computed
# (mise, shell profile, none), which has run the gate on three different
# compilers against one shared target dir — every switch rebuilds the world.
# Drop it so every recipe resolves through rust-toolchain.toml.
unexport RUSTUP_TOOLCHAIN

manifest := "src-tauri/Cargo.toml"
# Cargo's output root, honouring CARGO_TARGET_DIR the way cargo itself does.
target := env("CARGO_TARGET_DIR", justfile_directory() / "src-tauri/target")

# The Rust suite drives real `git` subprocesses. Without this the developer's
# editor vars and global git config decide which path a test takes, and the
# rebase editor-pin guards pass with the production fix reverted.
scrubbed_env := "env -u GIT_EDITOR -u EDITOR -u VISUAL GIT_CONFIG_GLOBAL=/dev/null"

# List available recipes
default:
    @just --list

# ── Dev ──────────────────────────────────────────────

# Start development server (own identifier so dev state never clobbers the installed app's)
dev:
    bun run tauri dev -c tauri.dev.conf.json

# Dev server with performance instrumentation on (samples: /tmp/trunk-perf/samples.jsonl)
perf:
    VITE_PERF=1 bun run tauri dev -c tauri.dev.conf.json

# Per-operation timing distributions from the last `just perf` session (`just perf-report 100` also lists each sample at or over 100ms)
perf-report over="":
    bun run scripts/perf-report.ts {{ if over == "" { "" } else { "--over " + over } }}

# Production build
build:
    bun run tauri build

# ── Checks ───────────────────────────────────────────

# Static checks only — no compile, no tests (~3s)
quick: fmt biome svelte-check

# Everything that touches the frontend (~14s)
front: biome svelte-check vitest

# Everything that touches Rust (~12s, more after an edit)
rust: fmt clippy clippy-shipped cargo-test

# Run all checks (run before committing)
check: fmt biome svelte-check clippy clippy-shipped cargo-test vitest graph-sweep-check app-test toolchain-parity

# Verify every file naming the rust version names the same one (milliseconds)
toolchain-parity:
    #!/usr/bin/env bash
    set -euo pipefail
    pinned=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
    mised=$(sed -n 's/^rust *= *"\(.*\)"/\1/p' mise.toml)
    released=$(sed -n 's/^ *toolchain: *\(.*\)/\1/p' .github/workflows/release.yml)
    for pair in "mise.toml:$mised" "release.yml:$released"; do
        if [ "${pair#*:}" != "$pinned" ]; then
            echo "::error::${pair%%:*} says '${pair#*:}', rust-toolchain.toml says '$pinned' — a rustup directory override outranks both, so the mismatch would build on the pin with the other file's targets and caches. Make them equal."
            exit 1
        fi
    done

# Check Rust formatting
fmt:
    cargo fmt --all --manifest-path {{manifest}} --check

# Lint & format with Biome
biome:
    bunx biome ci .

# Svelte type checking
svelte-check:
    bun run check

# Clippy lints
clippy:
    cargo clippy --workspace --manifest-path {{manifest}} --all-targets -- -D warnings

# Clippy the configuration that actually ships. `clippy` above passes
# --all-targets, which pulls in the dev targets, and the dev-dependency on
# ourselves turns `test-util` on for all of them — so the feature-off build is
# the one configuration nothing else compiles. Without this recipe, code that
# reads a `test-util`-gated field from ungated code passes `just check` and
# fails only at `tauri build`.
clippy-shipped:
    cargo clippy --workspace --manifest-path {{manifest}} --lib --bins -- -D warnings

# Run Rust tests (needs: cargo install cargo-nextest). nextest runs every test
# binary in parallel where `cargo test` runs them serially — measured 7.2s
# against 17s on the same suites (TRUNK-67).
#
# No `cargo test --doc` line, though nextest cannot run doctests. There are none
# to run: the only fenced block in either crate is an ```ignore example, so the
# invocation executed nothing and cost 30s of compile in CI to do it — `--doc`
# needs the `staticlib` and `cdylib` crate types this package declares, which
# nextest never builds, so it relinked the crate from scratch.
#
# `test_doctest_guard.rs` is what makes the omission safe: it fails, naming the
# file and line, the moment a runnable example appears, and its message says to
# put this line back. It scans the sources in 17ms.
cargo-test:
    {{scrubbed_env}} cargo nextest run --workspace --manifest-path {{manifest}}

# Run Rust tests with coverage. Same nextest-vs-serial split as `cargo-test`
# above, for the same reason: plain `cargo llvm-cov` runs the test binaries one
# after another and spent ~65s where nextest spends 34s, on identical coverage
# (18124/22002 lines over 74 files, both ways). Measured at 30s in CI.
#
# No `--doc` line here, unlike `cargo-test`. Coverage builds into
# `target/llvm-cov-target`, so a `cargo test --doc` after it recompiles the whole
# crate uninstrumented — measured at 35s in CI to run a doctest suite that is
# empty, because the one doctest in the tree is an ```ignore block. `cargo-test`
# above still runs it, so the day a real doctest is written it is executed on
# every developer run and on macOS CI; it is only left out of the coverage job,
# where it cost more than everything it measured.
cargo-test-cov:
    {{scrubbed_env}} cargo llvm-cov nextest --workspace --manifest-path {{manifest}} --lcov --output-path rust-lcov.info
    {{scrubbed_env}} cargo llvm-cov report --manifest-path {{manifest}} --html --output-dir rust-coverage-html
    {{scrubbed_env}} cargo llvm-cov report --manifest-path {{manifest}} --fail-under-lines 65

# Run frontend tests
vitest:
    bun run test

# Run frontend tests with coverage
vitest-cov:
    bun run test -- --coverage.enabled

# Drive the assembled app headlessly: the real Svelte tree against a real Rust backend
app-test:
    cargo build --manifest-path {{manifest}} --example app_host
    TRUNK_APP_HOST="{{target}}/debug/examples/app_host" bun run test:app

# Repeat the two frontend suites to catch a wait that only fails sometimes (`just flake-hunt 20`)
flake-hunt runs="10":
    #!/usr/bin/env bash
    set -uo pipefail
    cargo build --manifest-path {{manifest}} --example app_host
    failures=0
    for i in $(seq {{runs}}); do
        if ! TRUNK_APP_HOST="{{target}}/debug/examples/app_host" bun run test:app >/tmp/flake-app-$i.log 2>&1; then
            failures=$((failures + 1))
            echo "::group::app-test run $i failed"
            cat /tmp/flake-app-$i.log
            echo "::endgroup::"
        fi
        if ! bun run test >/tmp/flake-vitest-$i.log 2>&1; then
            failures=$((failures + 1))
            echo "::group::vitest run $i failed"
            cat /tmp/flake-vitest-$i.log
            echo "::endgroup::"
        fi
    done
    echo "{{runs}} runs of each suite, $failures failed"
    if [ "$failures" -ne 0 ]; then
        echo "::error::a frontend suite failed $failures time(s) over {{runs}} runs; a wait that fails under contention is the defect, not the runner. Read TRUNK-62 (backlog task 62 --plain) before investigating: it records what is already ruled out."
        exit 1
    fi

# Serve the real app to a browser so its rendered DOM can be measured (jsdom has no layout)
measure:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build --manifest-path {{manifest}} --example app_host
    # The bridge seeds a repository before it writes the token, which takes ten
    # seconds or so, while vite is ready in under one. The page imports the
    # token with ?raw at module load and vite caches that, so a browser opening
    # early binds a missing or stale token and every request 403s until the
    # module cache is cleared. Wait for the token this run wrote before saying
    # the page is ready.
    rm -f scripts/measure/.bridge-token.txt
    TRUNK_APP_HOST="{{target}}/debug/examples/app_host" bun scripts/measure/bridge.ts &
    bunx vite --port 1420 --strictPort &
    for _ in $(seq 1 60); do
      [ -s scripts/measure/.bridge-token.txt ] && break
      sleep 1
    done
    [ -s scripts/measure/.bridge-token.txt ] || { echo "bridge did not write a token" >&2; exit 1; }
    echo "open http://localhost:1420/scripts/measure/index.html"
    wait

# ── Audits (not part of `check`) ─────────────────────

# Scan dependencies for known advisories (needs: cargo install cargo-audit)
audit:
    cargo audit --file src-tauri/Cargo.lock
    bun audit

# Report which mutations the Rust tests miss (slow; needs: cargo install cargo-mutants)
mutants *args:
    cargo mutants --manifest-path {{manifest}} {{args}}

# ── Commit graph goldens ─────────────────────────────

# Accept a changed commit-graph layout, recording why (refuses without a reason)
graph-accept reason="":
    scripts/graph-accept.sh {{quote(reason)}}

# Rebuild the fixture corpus and re-capture the golden suite's committed inputs
graph-capture:
    scripts/graph-capture.sh

# Prove every captured rule input still equals a fresh capture of its repository (slow)
graph-fidelity:
    {{scrubbed_env}} GIT_CONFIG_SYSTEM=/dev/null cargo test --manifest-path {{manifest}} --test test_graph_capture -- --ignored

# Verify every recorded mutation anchor still matches its source exactly once (milliseconds)
graph-sweep-check:
    python3 scripts/graph-mutation-sweep.py --check

# Render one fixture's committed export as a viewable SVG (nothing committed)
graph-svg fixture="":
    #!/usr/bin/env bash
    set -euo pipefail
    out="$(mktemp -t trunk-graph-XXXXXX).svg"
    bun run scripts/graph-fixture-render.ts {{quote(fixture)}} > "$out"
    echo "$out" >&2
    open "$out"

# Measure mutation coverage: apply each anchor, run the four graph suites, restore (26-32 min)
graph-sweep *args="--run":
    python3 scripts/graph-mutation-sweep.py {{args}}

# ── Fixtures ─────────────────────────────────────────

# Build the fixture corpus into repos/ (every case, or the ones whose name contains an argument: `just fixtures nested`)
fixtures *cases:
    cargo run --quiet --manifest-path {{manifest}} -p trunk-fixtures -- build {{cases}}

# List the cases and what each one proves
fixtures-list:
    cargo run --quiet --manifest-path {{manifest}} -p trunk-fixtures -- list

# ── Benchmarks ───────────────────────────────────────

# Run all benchmarks
bench:
    cd src-tauri && cargo bench

# Compile-check benchmarks. Costs a relink of the crate wherever it runs, and no
# placement avoids that: `--no-run` links the bench binaries, which pulls in the
# `staticlib` and `cdylib` crate types this package declares, and nothing else in
# CI builds those — nextest needs only the rlib, and clippy only checks.
#
# Measured attempts, in order: after the coverage run, 29s (llvm-cov builds into
# its own target dir); after `just clippy`, 169s (a check leaves no linkable
# artifacts at all, so criterion and git2 compiled from source); after
# `just cargo-test`, 7s — which was a mistake to read as the real cost, because
# the `cargo test --doc` step then running just before it had already built those
# same two crate types. With that step gone the same placement measured 37s.
#
# So it sits in the Clippy job, which is the shortest job in CI, to keep the 37s
# off the macOS job that sets the critical path. That is the only lever left.
bench-check:
    cargo test --benches --no-run --manifest-path {{manifest}}
