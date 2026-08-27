set shell := ["bash", "-euo", "pipefail", "-c"]

manifest := "src-tauri/Cargo.toml"

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

# Static checks only — no compile, no tests (~7s)
quick: fmt biome svelte-check

# Everything that touches the frontend (~16s)
front: biome svelte-check vitest

# Everything that touches Rust (~26s, more after an edit)
rust: fmt clippy cargo-test

# Run all checks (run before committing)
check: fmt biome svelte-check clippy cargo-test vitest graph-sweep-check app-test

# Check Rust formatting
fmt:
    cargo fmt --manifest-path {{manifest}} --check

# Lint & format with Biome
biome:
    bunx biome ci .

# Svelte type checking
svelte-check:
    bun run check

# Clippy lints
clippy:
    cargo clippy --manifest-path {{manifest}} --all-targets -- -D warnings

# Run Rust tests
cargo-test:
    {{scrubbed_env}} cargo test --manifest-path {{manifest}}

# Run Rust tests with coverage
cargo-test-cov:
    {{scrubbed_env}} cargo llvm-cov --manifest-path {{manifest}} --lcov --output-path rust-lcov.info
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
    TRUNK_APP_HOST="${CARGO_TARGET_DIR:-{{justfile_directory()}}/src-tauri/target}/debug/examples/app_host" bun run test:app

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

# ── Benchmarks ───────────────────────────────────────

# Run all benchmarks
bench:
    cd src-tauri && cargo bench

# Compile-check benchmarks
bench-check:
    cargo test --benches --no-run --manifest-path {{manifest}}
