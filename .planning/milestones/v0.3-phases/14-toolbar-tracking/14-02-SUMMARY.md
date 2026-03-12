---
phase: 14-toolbar-tracking
plan: 02
subsystem: ui
tags: [undo, redo, toolbar, tauri-commands, svelte5, git-reset]

requires:
  - phase: 12-commit-context-menu
    provides: commit_actions.rs module with reset/cherry-pick/revert pattern
provides:
  - undo_commit Tauri command (soft-reset HEAD~1, returns saved message)
  - redo_commit Tauri command (re-commits with saved subject/body)
  - check_undo_available Tauri command (lightweight HEAD check)
  - Frontend undo/redo state module with ephemeral redo stack
  - Toolbar Undo/Redo buttons with correct disabled states
affects: []

tech-stack:
  added: []
  patterns: [isUndoing/isRedoing flag guards for redo stack clearing]

key-files:
  created:
    - src/lib/undo-redo.svelte.ts
  modified:
    - src-tauri/src/commands/commit_actions.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/git/types.rs
    - src/components/Toolbar.svelte

key-decisions:
  - "check_undo_available IPC for canUndo state instead of threading graph data to Toolbar"
  - "isUndoing/isRedoing flags to prevent redo stack clearing during undo/redo repo-changed events"

patterns-established:
  - "Flag-guarded event listener: track async operation state to distinguish self-triggered events from external ones"

requirements-completed: [TOOLBAR-01, TOOLBAR-02, TOOLBAR-03]

duration: 4min
completed: 2026-03-12
---

# Phase 14 Plan 02: Undo/Redo Toolbar Buttons Summary

**Undo/Redo commit buttons with soft-reset, ephemeral redo stack, and check_undo_available IPC for disabled state**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T15:30:16Z
- **Completed:** 2026-03-12T15:34:29Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Backend undo_commit soft-resets HEAD~1 and returns captured subject/body as UndoResult
- Backend redo_commit re-commits with saved message via create_commit_inner delegation
- Frontend ephemeral redo stack with push/pop/clear, redo stack clears on non-redo commits
- Toolbar button order: [Undo] [Redo] | [Pull] [Push] | [Branch] [Stash] [Pop]
- Undo disabled on initial/merge commits; Redo disabled when stack empty

## Task Commits

Each task was committed atomically:

1. **Task 1: Add undo_commit and redo_commit Tauri commands** - `d7eadb3` (feat)
2. **Task 2: Create undo/redo frontend state and wire Toolbar buttons** - `cb05622` (feat)

## Files Created/Modified
- `src-tauri/src/git/types.rs` - Added UndoResult struct
- `src-tauri/src/commands/commit_actions.rs` - undo_commit_inner, redo_commit_inner, check_undo_available_inner + Tauri wrappers + 3 tests
- `src-tauri/src/lib.rs` - Registered undo_commit, redo_commit, check_undo_available in invoke_handler
- `src/lib/undo-redo.svelte.ts` - Ephemeral redo stack state module (pushToRedoStack, popFromRedoStack, clearRedoStack)
- `src/components/Toolbar.svelte` - Undo/Redo buttons, canUndo check, isUndoing/isRedoing flag guards

## Decisions Made
- Used a dedicated `check_undo_available` IPC command instead of threading graph data as props to Toolbar -- keeps Toolbar self-contained
- Used isUndoing/isRedoing flags to prevent redo stack clearing when repo-changed fires from undo/redo operations themselves
- redo_commit_inner delegates to create_commit_inner rather than duplicating commit logic

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added check_undo_available command**
- **Found during:** Task 2 (Toolbar wiring)
- **Issue:** Plan suggested deriving canUndo from graph data props or a check function but didn't specify a concrete IPC command
- **Fix:** Added check_undo_available_inner + Tauri wrapper that checks HEAD parent count (returns true only for single-parent commits)
- **Files modified:** src-tauri/src/commands/commit_actions.rs, src-tauri/src/lib.rs
- **Verification:** cargo build succeeds, canUndo updates on repo-changed events
- **Committed in:** d7eadb3 (Task 1 commit, pre-emptively added with other backend commands)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Necessary for correct Undo button disabled state. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Undo/Redo feature complete and ready for visual verification
- All 84 cargo tests pass including 3 new undo-specific tests

---
*Phase: 14-toolbar-tracking*
*Completed: 2026-03-12*
