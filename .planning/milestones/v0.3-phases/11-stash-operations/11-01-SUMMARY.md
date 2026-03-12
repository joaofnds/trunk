---
phase: 11-stash-operations
plan: "01"
subsystem: api
tags: [rust, git2, tauri, stash, types]

# Dependency graph
requires: []
provides:
  - StashEntry struct with index, name, short_name, parent_oid fields in git/types.rs
  - RefsResponse.stashes changed from Vec<RefLabel> to Vec<StashEntry>
  - stash.rs command module: list_stashes, stash_save, stash_pop, stash_apply, stash_drop Tauri commands
  - All stash mutation commands follow cache-repopulate-before-emit pattern
affects:
  - 11-02 (graph rendering needs StashEntry.parent_oid to position stash rows)
  - 11-03 (sidebar UI calls stash_save, stash_pop, stash_apply, stash_drop commands)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-pass stash iteration: collect OIDs in stash_foreach, resolve parents in separate pass to avoid mutable borrow conflict"
    - "Block-scope statuses drop before walk_commits mutable borrow"
    - "cache-repopulate-before-emit: inner fn returns GraphResult, caller inserts into CommitCache then emits repo-changed"

key-files:
  created:
    - src-tauri/src/commands/stash.rs
  modified:
    - src-tauri/src/git/types.rs
    - src-tauri/src/commands/branches.rs
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs

key-decisions:
  - "Two-pass stash OID resolution: collect (idx, name, oid) in foreach callback, then resolve parent_oid after foreach releases mutable borrow"
  - "Block-scope pattern for Statuses drop: wrap repo.statuses() check in { } block so Statuses is dropped before walk_commits takes &mut repo"
  - "stash_pop/stash_apply check for CONFLICTED status after git2 call because git2 may return Ok(()) even when conflicts occurred"

patterns-established:
  - "Two-pass stash iteration: whenever stash_foreach is needed + post-foreach repo access, collect in Vec then process after"
  - "Statuses borrow management: always wrap statuses checks in block scope before calling any &mut repo function"

requirements-completed:
  - STASH-01
  - STASH-03
  - STASH-04
  - STASH-05
  - STASH-06

# Metrics
duration: 3min
completed: 2026-03-11
---

# Phase 11 Plan 01: Stash Backend Summary

**Rust stash backend with StashEntry type (parent_oid for graph positioning), five Tauri commands (list/save/pop/apply/drop), and 7 passing unit tests following cache-repopulate-before-emit pattern**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-11T02:53:32Z
- **Completed:** 2026-03-11T02:56:45Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Added StashEntry struct with `index`, `name`, `short_name`, `parent_oid` fields; updated RefsResponse.stashes to Vec<StashEntry>
- Updated branches.rs stash_foreach to use two-pass pattern for parent_oid resolution (borrow-safe)
- Created stash.rs with 5 inner fns + 5 Tauri command wrappers + 7 unit tests; all 59 suite tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Add StashEntry type and update RefsResponse** - `c4ee5ef` (feat)
2. **Task 2: Update branches.rs stash_foreach to return StashEntry with parent_oid** - `acf3e01` (feat)
3. **Task 3: Create stash.rs command module with inner fns, commands, and tests** - `49a44f0` (feat)

## Files Created/Modified

- `src-tauri/src/git/types.rs` - Added StashEntry struct; changed RefsResponse.stashes to Vec<StashEntry>
- `src-tauri/src/commands/stash.rs` - New: list_stashes_inner, stash_save_inner, stash_pop_inner, stash_apply_inner, stash_drop_inner + Tauri wrappers + 7 tests
- `src-tauri/src/commands/branches.rs` - Updated stash_foreach to two-pass OID collection pattern; returns StashEntry with parent_oid
- `src-tauri/src/commands/mod.rs` - Added `pub mod stash`
- `src-tauri/src/lib.rs` - Registered 5 stash commands in invoke_handler

## Decisions Made

- Two-pass stash OID resolution: stash_foreach callback collects `(idx, name, *oid)` into a Vec, parent resolution runs after foreach releases the mutable borrow
- Block-scope pattern for Statuses: `repo.statuses()` wrapped in `{ }` block so the Statuses type is dropped before `walk_commits` takes `&mut repo`
- stash_pop and stash_apply check `git2::Status::CONFLICTED` after the git2 call succeeds, because git2 may return `Ok(())` even when conflicts occurred

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed borrow conflict in test helper make_test_repo and stash_save_clean_workdir**
- **Found during:** Task 3 (stash.rs tests)
- **Issue:** `drop(repo)` after `repo.find_tree()` failed — git2::Tree holds an immutable borrow of repo; cannot move out while borrow is live
- **Fix:** Wrapped initial commit block in `{ }` scope; tree drops at end of block, then repo drops at end of outer scope
- **Files modified:** src-tauri/src/commands/stash.rs (test module)
- **Verification:** cargo test -p trunk stash passes 8/8
- **Committed in:** 49a44f0 (Task 3 commit)

**2. [Rule 1 - Bug] Fixed borrow conflict between Statuses and &mut repo in stash_pop_inner and stash_apply_inner**
- **Found during:** Task 3 (stash.rs compilation)
- **Issue:** `repo.statuses(None)` returns `Statuses<'_>` holding immutable borrow; subsequent `graph::walk_commits(&mut repo, ...)` requires mutable borrow — conflict
- **Fix:** Wrapped statuses check in `{ }` block so Statuses drops before walk_commits is called
- **Files modified:** src-tauri/src/commands/stash.rs
- **Verification:** cargo test -p trunk stash passes 8/8; full suite 59/59
- **Committed in:** 49a44f0 (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - borrow lifetime bugs)
**Impact on plan:** Both fixes necessary for Rust borrow checker correctness. No scope creep.

## Issues Encountered

- Rust borrow checker required two fixes for stash ops: two-pass collection (already anticipated in plan) and block-scope Statuses drops (not anticipated). Both resolved inline during Task 3.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- StashEntry type with parent_oid is ready for plan 11-02 (graph rendering)
- All 5 Tauri commands registered and tested for plan 11-03 (sidebar UI)
- No blockers

---
*Phase: 11-stash-operations*
*Completed: 2026-03-11*
