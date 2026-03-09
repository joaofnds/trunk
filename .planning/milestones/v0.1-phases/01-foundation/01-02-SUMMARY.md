---
phase: 01-foundation
plan: "02"
subsystem: infra
tags: [rust, tauri, git2, cargo, serde, notify]

# Dependency graph
requires: []
provides:
  - "Cargo.toml with git2 0.19 (vendored), notify 7, notify-debouncer-mini 0.5, tauri-plugin-dialog 2"
  - "TrunkError unified error type (Serialize + From<git2::Error>)"
  - "RepoState path-keyed registry (Mutex<HashMap<String, PathBuf>>)"
  - "git/types.rs: all serializable DTO structs with owned types (GraphCommit, BranchInfo, FileDiff, etc.)"
  - "All module stubs declared in lib.rs and compiling (cargo build exits 0)"
affects:
  - "02-history"
  - "03-branches"
  - "04-staging"
  - "05-commits"
  - "06-diff"

# Tech tracking
tech-stack:
  added:
    - "git2 = 0.19 (vendored-libgit2feature for static linking)"
    - "notify = 7 (filesystem events)"
    - "notify-debouncer-mini = 0.5 (debounced file watching)"
    - "tauri-plugin-dialog = 2 (native open dialog)"
  patterns:
    - "TrunkError: single IPC error type with { code, message } for all Rust->TS error propagation"
    - "RepoState: store PathBuf only, never git2::Repository (not Sync); open fresh per command in spawn_blocking"
    - "DTO pattern: all git2 types converted immediately to owned-field structs (no lifetime parameters)"
    - "Module stubs: empty files compiled in module tree so feature phases can add code without restructuring"

key-files:
  created:
    - "src-tauri/src/error.rs"
    - "src-tauri/src/state.rs"
    - "src-tauri/src/watcher.rs"
    - "src-tauri/src/git/mod.rs"
    - "src-tauri/src/git/types.rs"
    - "src-tauri/src/git/repository.rs"
    - "src-tauri/src/git/graph.rs"
    - "src-tauri/src/commands/mod.rs"
    - "src-tauri/src/commands/repo.rs"
    - "src-tauri/src/commands/history.rs"
    - "src-tauri/src/commands/branches.rs"
    - "src-tauri/src/commands/staging.rs"
    - "src-tauri/src/commands/commit.rs"
    - "src-tauri/src/commands/diff.rs"
  modified:
    - "src-tauri/Cargo.toml"
    - "src-tauri/capabilities/default.json"
    - "src-tauri/src/lib.rs"

key-decisions:
  - "Used git2 vendored-libgit2 feature (not bundled — that feature does not exist in 0.19; vendored-libgit2 statically links libgit2)"
  - "RepoState stores PathBuf only, never git2::Repository, because Repository is not Sync and cannot be shared across threads"
  - "All DTO structs in git/types.rs use owned types to avoid git2 lifetime parameters leaking into IPC layer"
  - "tauri-plugin-opener removed, tauri-plugin-dialog added for native folder-open dialog"

patterns-established:
  - "TrunkError { code: String, message: String } is the only IPC error type; From<git2::Error> auto-converts"
  - "Commands open Repository::open(path) fresh inside spawn_blocking — never store Repository in state"
  - "DTO conversion at git2 boundary: commit/diff/ref → owned struct immediately"

requirements-completed:
  - INFRA-02
  - INFRA-03

# Metrics
duration: 5min
completed: 2026-03-03
---

# Phase 1 Plan 02: Rust Scaffold Summary

**Compiling Rust scaffold with git2 0.19 + notify, TrunkError/RepoState primitives, and 13 module stubs wired into lib.rs**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-03T20:53:26Z
- **Completed:** 2026-03-03T20:58:50Z
- **Tasks:** 2
- **Files modified:** 17

## Accomplishments
- Updated Cargo.toml: replaced tauri-plugin-opener with tauri-plugin-dialog; added git2 (vendored), notify, notify-debouncer-mini
- Implemented error.rs (TrunkError with Serialize + From<git2::Error>) and state.rs (RepoState with PathBuf-only Mutex map)
- Created all 13 module stubs across git/ and commands/ directories plus watcher.rs
- Replaced lib.rs: removed greet command, wired 5 modules, registered dialog plugin and RepoState
- cargo build exits 0; all DTO structs in git/types.rs compile with owned types only

## Task Commits

Each task was committed atomically:

1. **Task 1: Update Cargo.toml and capabilities; implement error.rs and state.rs** - `a8433d4` (feat)
2. **Task 2: Scaffold all module stubs + git/types.rs + wire lib.rs** - `505b591` (feat)

## Files Created/Modified
- `src-tauri/Cargo.toml` - Added git2 (vendored-libgit2), notify, notify-debouncer-mini, tauri-plugin-dialog; removed tauri-plugin-opener
- `src-tauri/capabilities/default.json` - Replaced opener:default with dialog:allow-open
- `src-tauri/src/lib.rs` - Removed greet, declared 5 modules, registered dialog plugin and RepoState
- `src-tauri/src/error.rs` - TrunkError { code, message } with Serialize and From<git2::Error>
- `src-tauri/src/state.rs` - RepoState(Mutex<HashMap<String, PathBuf>>) — path-keyed registry
- `src-tauri/src/git/types.rs` - All serializable DTO structs: GraphCommit, BranchInfo, FileDiff, CommitDetail, etc.
- `src-tauri/src/git/mod.rs` - Declares graph, repository, types submodules
- `src-tauri/src/git/repository.rs` - Stub (Phase 2)
- `src-tauri/src/git/graph.rs` - Stub (Phase 2)
- `src-tauri/src/watcher.rs` - Stub (Phase 4)
- `src-tauri/src/commands/mod.rs` - Declares all 6 command submodules
- `src-tauri/src/commands/repo.rs` - Stub (Phase 2)
- `src-tauri/src/commands/history.rs` - Stub (Phase 2)
- `src-tauri/src/commands/branches.rs` - Stub (Phase 3)
- `src-tauri/src/commands/staging.rs` - Stub (Phase 4)
- `src-tauri/src/commands/commit.rs` - Stub (Phase 5)
- `src-tauri/src/commands/diff.rs` - Stub (Phase 6)

## Decisions Made
- Used `vendored-libgit2` feature (not `bundled` — that feature name does not exist in git2 0.19; `vendored-libgit2` is the correct feature for static libgit2 linking)
- RepoState stores PathBuf only because git2::Repository is not Sync and cannot be stored in Tauri managed state
- All DTO structs use owned types (String, Vec, i64, u32, usize, bool, Option<T>) to avoid git2 lifetime parameters propagating into the IPC layer

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected git2 bundled feature name from "bundled" to "vendored-libgit2"**
- **Found during:** Task 1 (Update Cargo.toml)
- **Issue:** Plan specified `git2 = { version = "0.19", features = ["bundled"] }` as a fallback but `bundled` is not a valid feature for git2 0.19. cargo resolve failed immediately.
- **Fix:** Queried crates.io API to confirm the correct feature name is `vendored-libgit2`. Updated Cargo.toml entry to `features = ["vendored-libgit2"]`.
- **Files modified:** src-tauri/Cargo.toml
- **Verification:** cargo build exits 0 with vendored-libgit2 feature
- **Committed in:** a8433d4 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — incorrect feature name in plan)
**Impact on plan:** Fix necessary for the build to resolve at all. No scope creep. Static linking preserved as intended.

## Issues Encountered
- git2 feature name in plan was `bundled` (invalid for 0.19); correct name is `vendored-libgit2`. Detected on first cargo check and fixed immediately.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All module stubs are in place; Phase 2 can immediately add implementation to git/repository.rs, git/graph.rs, and commands/repo.rs + commands/history.rs
- TrunkError and RepoState primitives are fully implemented and ready for use
- No blockers

## Self-Check: PASSED

- All 7 key files exist on disk (verified)
- Both task commits found in git log: a8433d4, 505b591
- cargo build exits 0 (verified in final verification step)

---
*Phase: 01-foundation*
*Completed: 2026-03-03*
