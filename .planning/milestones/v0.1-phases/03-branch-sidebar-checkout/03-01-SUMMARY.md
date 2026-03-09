---
phase: 03-branch-sidebar-checkout
plan: "01"
subsystem: git
tags: [rust, git2, tauri, branches, tdd]

# Dependency graph
requires:
  - phase: 02-repository-open-commit-graph
    provides: "RepoState, CommitCache state types; graph::walk_commits; make_test_repo() test helper; TrunkError IPC type"
provides:
  - "list_refs Tauri command returning local branches, remote branches (origin/HEAD filtered), tags, stashes"
  - "checkout_branch Tauri command with dirty-workdir guard and cache rebuild"
  - "create_branch Tauri command with auto-checkout and cache rebuild"
  - "is_dirty() helper excluding WT_NEW per git checkout semantics"
  - "open_repo_from_state() helper for state-map lookup pattern"
affects:
  - 03-02-branch-sidebar-ui
  - 03-03-branch-wiring

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "inner fn pattern: public inner fns (list_refs_inner etc.) callable from tests without Tauri state"
    - "OID extraction pattern: repo.head()?.target() + repo.find_commit(oid) to avoid lifetime conflicts when dropping repo"
    - "cache rebuild pattern: drop repo, open fresh mut repo2, walk_commits, insert into cache_map"

key-files:
  created: []
  modified:
    - src-tauri/src/commands/branches.rs

key-decisions:
  - "is_dirty() excludes WT_NEW — untracked files do not block git checkout per standard git behavior"
  - "open_repo_from_state() extracted as shared helper to reduce state-map lookup boilerplate"
  - "head_name resolved eagerly (before stash_foreach mutable borrow) to satisfy Rust borrow checker"
  - "create_branch_inner uses repo.head()?.target() + find_commit(oid) to drop commit before auto-checkout"

patterns-established:
  - "Inner fn pattern: *_inner functions accept plain HashMap args, wrapped by async Tauri command with spawn_blocking"
  - "Cache rebuild: always rebuild graph cache after any branch mutation (checkout or create)"

requirements-completed: [BRNCH-01, BRNCH-03, BRNCH-04]

# Metrics
duration: 4min
completed: 2026-03-04
---

# Phase 3 Plan 01: Branch Commands Summary

**Three git2 Tauri commands (list_refs, checkout_branch, create_branch) with dirty-workdir guard, is_dirty() helper, and 7 passing TDD tests — Rust backend fully ready for sidebar UI wiring**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-03-04T13:15:42Z
- **Completed:** 2026-03-04T13:19:33Z
- **Tasks:** 3 (RED, GREEN, REFACTOR)
- **Files modified:** 1

## Accomplishments
- Wrote 7 failing tests covering all branch command behaviors before any implementation (RED)
- Implemented list_refs, checkout_branch, create_branch with is_dirty() guard and cache rebuild (GREEN)
- Extracted open_repo_from_state() helper and fixed unused variable warning (REFACTOR)
- Full test suite: 17/17 tests pass, no regressions from Phase 2

## Task Commits

Each task was committed atomically:

1. **Task 1: RED - Failing tests** - `83ee80f` (test)
2. **Task 2: GREEN+REFACTOR - Implementation** - `df4f8c5` (feat)

_Note: REFACTOR was minimal (one variable rename) and merged into the GREEN commit._

## Files Created/Modified
- `src-tauri/src/commands/branches.rs` - Full implementation: is_dirty(), open_repo_from_state(), list_refs_inner(), list_refs, checkout_branch_inner(), checkout_branch, create_branch_inner(), create_branch, plus #[cfg(test)] module with 7 tests

## Decisions Made
- `is_dirty()` deliberately excludes `WT_NEW` (untracked files) — this matches standard git checkout behavior where untracked files do not prevent branch switching
- `open_repo_from_state()` extracted to eliminate repeated state-map lookup boilerplate across all three commands
- HEAD name resolved eagerly before `stash_foreach` mutable borrow to satisfy Rust borrow checker constraints
- `create_branch_inner` uses `repo.head()?.target()` + `find_commit(oid)` pattern to avoid lifetime conflict when needing to drop the commit before calling `set_head` and `checkout_head`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed borrow checker lifetime conflicts in test setup and implementation**
- **Found during:** Task 1 (RED - test compilation) and Task 2 (GREEN - implementation)
- **Issue:** `head_ref` borrow on repo conflicted with `stash_foreach` mutable borrow; `head_commit` borrow prevented `drop(repo)` in create_branch_inner; test setup used `peel_to_commit()` creating lifetime conflicts with `drop(repo)`
- **Fix:** Extract OIDs/values before long-lived borrows; use `head().target()` + `find_commit(oid)` pattern; scope repo ops in `{}` blocks in tests
- **Files modified:** src-tauri/src/commands/branches.rs
- **Verification:** cargo test passes with all 7 branch tests green
- **Committed in:** df4f8c5 (GREEN implementation commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug: borrow checker lifetime conflicts)
**Impact on plan:** Required fix was purely mechanical Rust lifetime management. No semantic changes, no architectural decisions, no scope creep.

## Issues Encountered
- Rust borrow checker required OID extraction pattern (`target()` + `find_commit()`) rather than direct `peel_to_commit()` in places where the commit's lifetime needed to end before the repo was mutated or dropped. This is a standard Rust idiom and was resolved inline.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three Tauri commands (`list_refs`, `checkout_branch`, `create_branch`) are exported from branches.rs and ready to register in `generate_handler![]`
- Plan 03-02 (sidebar UI) can now define Svelte components calling these commands via safeInvoke
- Plan 03-03 (wiring) will register commands in lib.rs and connect frontend to backend

---
*Phase: 03-branch-sidebar-checkout*
*Completed: 2026-03-04*
