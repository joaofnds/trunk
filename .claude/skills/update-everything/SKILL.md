---
name: update-everything
description: >
  Sweep every version-bearing surface of the repo to latest — mise toolchain,
  Rust crates, frontend deps, e2e deps, GitHub Actions — majors included.
  Parallel agents per ecosystem, revert-if-red per item, one commit per
  ecosystem. HALT if the tree is dirty or the baseline check is red.
argument-hint: "[actions | crates | frontend | e2e | mise ...]"
disable-model-invocation: true
---

# Update Everything

Bring the whole project to current versions in one sweep. Policy decisions
(already made — do not re-ask):

- **Attempt everything, including majors.** vite 7, git2 0.20, TS bumps, Rust
  edition 2024 — apply them and fix the fallout. Any single bump that cannot be
  made green gets **reverted and reported**, never left red.
- **One commit per ecosystem**, so a bad wave reverts cleanly.
- **Never touch `src-tauri/tauri.conf.json`'s `version`** — it is frozen and
  decoupled from release tags on purpose.

## Argument

Optional space-separated ecosystem filter: any of `actions`, `crates`,
`frontend`, `e2e`, `mise`. No argument = all five.

## Phase 0 — Preflight (HALT conditions)

1. On `main` with a clean tree: `git status --porcelain` must be empty.
   Dirty → HALT; updates must not entangle with in-flight work.
2. Baseline green: run `just check`. Red → HALT and report — never let a
   pre-existing failure be blamed on the updates.
3. Record `git rev-parse HEAD` as the rollback anchor and tell the user:
   "revert anchor: `<sha>`".

## Phase 1 — mise toolchain (inline, BEFORE the parallel wave)

Runs first because a Rust bump changes the compiler every later Rust step
uses — CI installs exactly these pins via mise-action.

1. For each tool in `mise.toml`: `mise latest <tool>`.
2. Edit the pins, run `mise install`, then confirm the new versions are live
   (`mise exec -- rustc --version`, `mise exec -- bun --version`, …).
3. Commit now: `chore(deps): update mise toolchain` (only `mise.toml`).
   If a tool bump breaks `mise install`, revert that pin and note it.

## Phase 2 — Parallel ecosystem agents (edit-only, NO commits)

Launch the applicable agents **in a single message** so they run concurrently.
Every agent gets these standing orders in its prompt:

- Edit files only. **Do not `git commit`, `git add`, or touch the index** —
  parallel commits race on the index lock; the orchestrator commits.
- Apply majors. For each bump that breaks the build/tests, try to fix the
  fallout in code; if you cannot get it green, revert **that one bump** and
  list it in your report as `reverted: <dep> <from>→<to> — <reason>`.
- Return a structured report: `updated:` (`<dep> <from>→<to>`) /
  `reverted:` / `flagged:` lists.

### Agent: actions

Scope: `.github/workflows/*.yml`.

- Enumerate every `uses:` line; dedupe by action.
- The repo **enforces SHA pinning** (`sha_pinning_required`). Every reference
  must stay `owner/repo@<full-commit-sha> # <human tag>`. To update one:
  1. Latest version: `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`
     (fall back to the newest tag for actions without releases).
  2. Resolve tag → commit: `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`;
     if the object type is `tag` (annotated), dereference it via
     `gh api repos/<owner>/<repo>/git/tags/<sha>` to reach the commit SHA.
  3. Replace the SHA and update the `# vX.Y.Z` comment in **every** workflow
     that uses the action — keep them consistent.
- Special cases:
  - `dtolnay/rust-toolchain@<sha> # stable` — pin to the latest commit on
    `master`, keep the `# stable` comment.
  - `taiki-e/install-action` — comment names the tool (`# cargo-llvm-cov`),
    not a version; update the SHA to the latest release, keep the comment.
- Flag (do not change): `release.yml` builds with `dtolnay/rust-toolchain` +
  `setup-bun` with no `bun-version` input (installs latest bun) instead of
  mise — release toolchain can drift from the mise pins CI uses.

### Agent: crates

Scope: `src-tauri/` (Cargo.toml, Cargo.lock, and any `src`/`tests`/`benches`
code fallout).

- For each `[dependencies]`/`[dev-dependencies]` entry, find the latest
  version (prefer `cargo upgrade --incompatible` if cargo-edit is available;
  otherwise `curl -s https://crates.io/api/v1/crates/<name>` and edit
  manually). Then `cargo update`.
- **Constraints:**
  - `yaml-rust` is deliberately pinned to whatever `syntect` resolves (see the
    comment in Cargo.toml). After bumping syntect, set yaml-rust to match
    `cargo tree -i yaml-rust`'s resolution — never rev it independently.
  - Never touch `tauri.conf.json`'s `version`.
  - If a Tauri **major** is applied, check its changelog for a raised macOS
    minimum and add it to `flagged:` — user-facing, never auto-bump.
- Attempt `edition = "2024"`: bump the field, run `cargo fix --edition`, then
  `cargo fmt`. Revert if it cannot be made green.
- Verify with **unfiltered** runs — a filtered `cargo test --lib <module>`
  passes green while the independent `src-tauri/tests/` binary fails to
  compile: `cargo clippy --all-targets -- -D warnings`, `cargo test`, and
  compile-check benches (`cargo bench --no-run`).

### Agent: frontend

Scope: root `package.json`, `bun.lock`, and code fallout under `src/`.

- `bun outdated` for the picture; apply updates by editing `package.json`
  (majors included — vite, typescript, vitest, testing-library, tailwind…)
  then `bun install`.
- Verify: `bun run check` (svelte-check), `bunx vitest run`,
  `bunx biome check .`.
- Flag (do not delete): the stale root `package-lock.json` — bun owns
  `bun.lock`; the npm lockfile looks dead and is a deletion candidate for the
  user to confirm.

### Agent: e2e

Scope: `e2e/` only (own `package.json` + `bun.lock`).

- Same treatment as frontend: `bun outdated` → edit → `bun install` in `e2e/`.
- E2E cannot run locally (needs a display driver); verification is
  install success + `bunx wdio config --help`-level smoke only. Flag that the
  real proof is the next CI e2e run.

## Phase 3 — Gate, fix, commit (orchestrator, sequential)

1. Read every agent report. If an agent died or returned nothing, check
   `git status --porcelain -- <its scope paths>`. Clean → report that
   ecosystem as untouched. Dirty → partial work: revert just those paths
   (`git restore --source=<anchor> --staged --worktree -- <paths>`) and
   report the ecosystem as reverted-incomplete.
2. Run the full gate: `just check` **and** `just bench-check` (CI
   compile-checks benches; `just check` does not).
3. Failures here are cross-ecosystem fallout — fix them in the working tree.
   If a specific bump is the culprit and unfixable, revert that bump and
   re-run the gate. Repeat until green. Cannot get green at all →
   `git reset --hard <anchor>` from repo root (safe: Phase 0 proved the tree
   clean, so everything after the anchor is this skill's own work — including
   the Phase 1 mise commit, which this removes) and HALT with the failing
   output. `git checkout <anchor> -- .` is **forbidden** (relative-path
   checkout from a stale cwd has wiped work before).
4. Sync `CLAUDE.md`'s Stack section with any version it names that changed —
   frontend *and* backend (it names git2, notify, tokio, Vite, TypeScript…).
   Stage each edit with the commit of the ecosystem that changed it.
5. Commit per ecosystem, sequentially, staging only that ecosystem's paths:
   - `chore(deps): update github actions` — `.github/workflows/`
   - `chore(deps): update rust crates` — `src-tauri/`. `tauri.conf.json`
     must not appear in the diff; if it does, an agent violated its
     constraint — revert that file before committing.
   - `chore(deps): update frontend dependencies` — `package.json`,
     `bun.lock`, `src/`
   - `chore(deps): update e2e dependencies` — `e2e/`
   Skip ecosystems with no changes. Commit directly to `main` — never create
   a branch.
6. Leftover unstaged files after the last commit = a scoping bug; stop and
   reconcile before reporting.

## Phase 4 — Report

End with a table per ecosystem: **updated** (dep, from → to), **reverted**
(dep + why), **flagged** (needs a human decision). Always include the standing
flags when applicable: `package-lock.json` deletion and `release.yml`
toolchain drift. Remind the user that e2e deps are only proven by the next
CI run.
