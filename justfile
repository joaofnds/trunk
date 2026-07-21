set shell := ["bash", "-euo", "pipefail", "-c"]

manifest := "src-tauri/Cargo.toml"

# List available recipes
default:
    @just --list

# ── Dev ──────────────────────────────────────────────

# Start development server (own identifier so dev state never clobbers the installed app's)
dev:
    bun run tauri dev -c tauri.dev.conf.json

# Production build
build:
    bun run tauri build

# Build the e2e-flavored debug binary (own identifier, own target dir)
e2e-build:
    CARGO_TARGET_DIR={{justfile_directory()}}/src-tauri/target/e2e bun run tauri build --debug --no-bundle --config e2e/tauri.e2e.conf.json

# ── Checks ───────────────────────────────────────────

# Static checks only — no compile, no tests (~7s)
quick: fmt biome svelte-check

# Everything that touches the frontend (~16s)
front: biome svelte-check vitest

# Everything that touches Rust (~26s, more after an edit)
rust: fmt clippy cargo-test

# Run all checks (run before committing)
check: fmt biome svelte-check clippy cargo-test vitest

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
    cargo test --manifest-path {{manifest}}

# Run Rust tests with coverage
cargo-test-cov:
    cargo llvm-cov --manifest-path {{manifest}} --lcov --output-path rust-lcov.info
    cargo llvm-cov report --manifest-path {{manifest}} --html --output-dir rust-coverage-html
    cargo llvm-cov report --manifest-path {{manifest}} --fail-under-lines 65

# Run frontend tests
vitest:
    bun run test

# Run frontend tests with coverage
vitest-cov:
    bun run test -- --coverage.enabled

# ── Audits (not part of `check`) ─────────────────────

# Scan dependencies for known advisories (needs: cargo install cargo-audit)
audit:
    cargo audit --file src-tauri/Cargo.lock
    bun audit
    bun --cwd e2e audit

# Report which mutations the Rust tests miss (slow; needs: cargo install cargo-mutants)
mutants *args:
    cargo mutants --manifest-path {{manifest}} {{args}}

# ── Benchmarks ───────────────────────────────────────

# Run all benchmarks
bench:
    cd src-tauri && cargo bench

# Compile-check benchmarks
bench-check:
    cargo test --benches --no-run --manifest-path {{manifest}}
