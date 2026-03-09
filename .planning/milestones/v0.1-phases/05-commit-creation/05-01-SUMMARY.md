---
phase: 05-commit-creation
plan: 01
subsystem: git
tags: [rust, git2, tauri, tdd, commit, amend]

requires:
  - phase: 04-working-tree-staging
    provides: inner-fn pattern with open_repo_from_state, spawn_blocking, CommitCache/RepoState state management

provides:
  - create_commit_inner (unborn HEAD safe commit creation)
  - amend_commit_inner (amend HEAD with optional staged changes)
  - get_head_commit_message_inner (read-only HEAD message for pre-population)
  - create_commit, amend_commit, get_head_commit_message Tauri command wrappers
  - HeadCommitMessage DTO in git/types.rs

affects: [05-02, 05-03, commit-form-frontend]

tech-stack:
  added: []
  patterns:
    - "inner fn pattern: pure git2 logic separated from Tauri state for direct test calls"
    - "unborn HEAD detection via ErrorCode::UnbornBranch in parents vec construction"
    - "build_message helper: subject-only vs. subject\\n\\nbody based on trimmed body"
    - "amend uses current index tree — always reflects staged changes at time of amend"
    - "cache.0.lock().unwrap().remove(&path) before app.emit(repo-changed) in mutating wrappers"

key-files:
  created: []
  modified:
    - src-tauri/src/commands/commit.rs
    - src-tauri/src/git/types.rs

key-decisions:
  - "body formatting: empty/whitespace-only body treated same as None — only subject emitted"
  - "get_head_commit_message is read-only: no cache invalidation or event emission"
  - "commands NOT registered in lib.rs generate_handler — deferred to Plan 03 per plan spec"

patterns-established:
  - "unborn HEAD: match repo.head() { Ok => vec![commit], Err(UnbornBranch) => vec![], Err(e) => Err }"
  - "amend: always pass Some(&tree) from current index to include staged changes"

requirements-completed: [COMIT-01, COMIT-03]

duration: 2min
completed: 2026-03-05
---

# Phase 5 Plan 01: Commit Creation and Amend Commands Summary

**Three git2 commit commands (create/amend/get_message) with unborn HEAD support, CommitCache invalidation, and 6 passing unit tests via TDD**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-05T17:40:21Z
- **Completed:** 2026-03-05T17:42:27Z
- **Tasks:** 2 (RED + GREEN, no REFACTOR needed)
- **Files modified:** 2

## Accomplishments

- TDD RED: 6 failing tests written covering create/amend/get_message behaviors including unborn HEAD and signature verification
- TDD GREEN: HeadCommitMessage DTO added to types.rs; create_commit_inner, amend_commit_inner, get_head_commit_message_inner implemented; all 6 tests pass
- Tauri wrappers for all three commands with CommitCache invalidation and repo-changed event in mutating commands

## Task Commits

1. **Task 1: RED — failing tests** - `c181522` (test)
2. **Task 2: GREEN — implementation** - `e980639` (feat)

## Files Created/Modified

- `src-tauri/src/commands/commit.rs` - Full TDD implementation: 3 inner fns, 3 Tauri wrappers, 6 unit tests
- `src-tauri/src/git/types.rs` - Added HeadCommitMessage DTO with Serialize+Deserialize derives; added Deserialize to serde import

## Decisions Made

- Body formatting: empty/whitespace-only body collapses to subject-only message (no trailing double-newline)
- get_head_commit_message is purely read-only — no cache invalidation or event emission needed
- Commands not registered in lib.rs generate_handler — deferred to Plan 03 per plan spec

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed borrow error in test for get_head_commit_message**
- **Found during:** Task 2 (GREEN — implementation), test compilation
- **Issue:** `drop(repo)` after `repo.commit()` failed to compile because `tree` still borrowed from `repo`
- **Fix:** Removed explicit `drop(repo)` — let both `tree` and `repo` drop naturally at end of block
- **Files modified:** src-tauri/src/commands/commit.rs (test only)
- **Verification:** `cargo test --lib commit` passes with all 6 tests green
- **Committed in:** e980639 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in test code)
**Impact on plan:** Minimal — lifetime issue in test setup only, no production code affected.

## Issues Encountered

None beyond the borrow error documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Rust IPC surface for commit creation complete: create_commit, amend_commit, get_head_commit_message ready to register
- CommitCache invalidation and repo-changed events wired — graph auto-refresh will work on commit
- Plan 02 (CommitForm frontend component) can now call these commands
- Plan 03 (command registration in lib.rs) needed before frontend can invoke the commands

---
*Phase: 05-commit-creation*
*Completed: 2026-03-05*
