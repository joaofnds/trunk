---
phase: 06-diff-display
plan: "01"
subsystem: api
tags: [rust, git2, diff, tauri, ipc]

# Dependency graph
requires:
  - phase: 04-working-tree-staging
    provides: "inner-function pattern, open_repo_from_state, is_head_unborn helpers"
  - phase: 05-commit-creation
    provides: "spawn_blocking command wrapper pattern, CommitCache, RepoState"
provides:
  - "diff_unstaged_inner: index-to-workdir diff with pathspec filter returning Vec<FileDiff>"
  - "diff_staged_inner: tree-to-index diff with unborn HEAD fallback returning Vec<FileDiff>"
  - "diff_commit_inner: tree-to-tree diff (root commit and non-root) returning Vec<FileDiff>"
  - "get_commit_detail_inner: CommitDetail DTO populated from git2 commit"
  - "4 Tauri command wrappers registered in lib.rs generate_handler"
affects: [06-diff-display frontend plans, DiffPanel.svelte]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "RefCell used in git2 Diff::foreach to share mutable state across multiple closures"
    - "walk_diff_into_file_diffs: shared helper fn for all diff walking"

key-files:
  created:
    - src-tauri/src/commands/diff.rs
  modified:
    - src-tauri/src/lib.rs

key-decisions:
  - "RefCell used in walk_diff_into_file_diffs to allow multiple closures to mutably borrow file_diffs — Rust borrow checker rejects multiple &mut borrows from the same closure group without it"
  - "walk_diff_into_file_diffs extracted as shared helper — all three diff commands use identical walking logic, only differ in how they produce the git2::Diff"
  - "diff_commit_inner uses None parent_tree when parent_count == 0 — correct git semantics for root commit diff vs empty tree"
  - "diff_staged_inner checks is_head_unborn before peel_to_tree — passes None as old_tree to diff_tree_to_index for unborn HEAD repos"

patterns-established:
  - "RefCell pattern: use std::cell::RefCell to share mutable Vec across multiple git2 foreach closures"
  - "Diff walking: file_cb builds FileDiff, hunk_cb appends DiffHunk to last FileDiff, line_cb appends DiffLine to last hunk"

requirements-completed: [DIFF-01, DIFF-02, DIFF-03, DIFF-04]

# Metrics
duration: 2min
completed: 2026-03-07
---

# Phase 6 Plan 01: Rust Diff Commands Summary

**Four git2 diff inner functions + Tauri wrappers implemented with 8 unit tests covering unstaged/staged/commit/root-commit/unborn-HEAD edge cases, all registered in IPC bridge**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-07T19:54:58Z
- **Completed:** 2026-03-07T19:56:40Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- 8-test TDD suite covering all diff edge cases (unborn HEAD, root commit, binary detection, clean file)
- 4 inner functions implementing unstaged, staged, commit, and commit detail diffs using git2 API
- 4 Tauri command wrappers following the established spawn_blocking pattern from staging.rs
- All 4 commands registered in lib.rs generate_handler — IPC bridge fully wired for frontend

## Task Commits

Each task was committed atomically:

1. **RED: 8 failing diff tests** - `e7052af` (test)
2. **GREEN: implement diff inner fns** - `8de479c` (feat)
3. **Task 2: register commands in lib.rs** - `4871b4e` (feat)

_Note: TDD task had 2 commits (test RED → feat GREEN)_

## Files Created/Modified

- `src-tauri/src/commands/diff.rs` - All four inner fns, 4 Tauri wrappers, 8 unit tests
- `src-tauri/src/lib.rs` - Added diff_unstaged, diff_staged, diff_commit, get_commit_detail to generate_handler

## Decisions Made

- **RefCell in walk_diff_into_file_diffs:** The Rust borrow checker rejects multiple `&mut` closures capturing the same variable in git2's `Diff::foreach`. Used `RefCell<Vec<FileDiff>>` to allow interior mutability across all three closure callbacks (file_cb, hunk_cb, line_cb).
- **Shared walk helper:** Extracted `walk_diff_into_file_diffs(diff: git2::Diff<'_>)` as a standalone function since all three diff commands produce a `git2::Diff` via different means but walk it identically.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RefCell required for git2 foreach multi-closure mutable borrow**
- **Found during:** Task 1 GREEN phase (implementing inner fns)
- **Issue:** Plan specified `&mut |closure|` callbacks sharing `file_diffs` variable, but Rust borrow checker rejects multiple simultaneous `&mut` borrows from closures all passed to the same `foreach` call
- **Fix:** Wrapped `file_diffs` in `std::cell::RefCell`, used `borrow_mut()` inside each closure
- **Files modified:** src-tauri/src/commands/diff.rs
- **Verification:** `cargo test --lib diff` — all 8 tests pass
- **Committed in:** 8de479c (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - borrow checker constraint)
**Impact on plan:** Fix required for correctness — RefCell is the standard Rust pattern for this exact scenario. No scope creep.

## Issues Encountered

None beyond the RefCell deviation above.

## Next Phase Readiness

- All 4 diff IPC commands available: `diff_unstaged`, `diff_staged`, `diff_commit`, `get_commit_detail`
- Frontend can now call these commands via `safeInvoke` with the signatures defined in RESEARCH.md
- Ready for Phase 6 Plan 02 (DiffPanel.svelte frontend component)

---
*Phase: 06-diff-display*
*Completed: 2026-03-07*
