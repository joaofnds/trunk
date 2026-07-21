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

# Run frontend tests
vitest:
    bun run test

# Run frontend tests with coverage
vitest-cov:
    bun run test -- --coverage.enabled

# ── Benchmarks ───────────────────────────────────────

# Run all benchmarks
bench:
    cd src-tauri && cargo bench

# Compile-check benchmarks
bench-check:
    cargo test --benches --no-run --manifest-path {{manifest}}
