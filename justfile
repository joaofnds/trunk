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

# Build and launch a dev .app bundle an agent's screen tools can see (docs/build-environment.md)
dev-app:
    #!/usr/bin/env bash
    set -euo pipefail
    # mise's python ships an `xattr` that shadows the system one and rejects the
    # `-r` that tauri's bundling step passes it.
    PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" bun run tauri build --debug -b app -c tauri.dev.conf.json
    open -n src-tauri/target/debug/bundle/macos/trunk.app

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
check: fmt biome svelte-check clippy clippy-shipped cargo-test vitest graph-sweep-check app-test toolchain-parity dev-conf-parity contrast

# Every audited text/background pair in src/app.css still clears its WCAG target (milliseconds)
contrast:
    bun scripts/contrast/re-audit-verify.mjs

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

# Verify the dev overlay's window equals the shipped one plus its one dev-only key (milliseconds)
dev-conf-parity:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 - <<'EOF'
    import json, sys
    shipped = json.load(open("src-tauri/tauri.conf.json"))["app"]["windows"]
    dev = json.load(open("tauri.dev.conf.json"))["app"]["windows"]
    dev_only = {"acceptFirstMouse": True}
    stripped = [{k: v for k, v in w.items() if k not in dev_only} for w in dev]
    missing = [k for w in dev for k, v in dev_only.items() if w.get(k) != v]
    if stripped != shipped or missing:
        print("::error::tauri.dev.conf.json's windows must equal tauri.conf.json's plus acceptFirstMouse=true. The overlay replaces the array whole (RFC 7396), so a shipped window change not copied there is silently absent from `just dev-app`, and without acceptFirstMouse a session's background clicks never reach the webview.")
        sys.exit(1)
    EOF

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
# No `--doc` line: there are no runnable doctests, and adding one relinks the
# crate. `test_doctest_guard.rs` fails if that stops being true.
cargo-test:
    {{scrubbed_env}} cargo nextest run --workspace --manifest-path {{manifest}}

# Run Rust tests with coverage. Through nextest for the same reason as
# `cargo-test`; coverage is identical either way.
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

# Compile-check benchmarks. `--no-run` links, so this needs a job that has
# already built the crate: in CI, only after `just cargo-test`. Next to a
# check-only job it rebuilds the dependency tree from source (187s vs 37s).
bench-check:
    cargo test --benches --no-run --manifest-path {{manifest}}
