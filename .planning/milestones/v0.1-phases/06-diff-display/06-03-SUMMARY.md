---
phase: 06-diff-display
plan: "03"
subsystem: ui
tags: [svelte, diff, ipc, layout, toggle]

requires:
  - phase: 06-01
    provides: Rust IPC commands diff_unstaged, diff_staged, diff_commit, get_commit_detail
  - phase: 06-02
    provides: DiffPanel.svelte renderer with commit metadata header and hunk display

provides:
  - Click-to-diff wired end-to-end: FileRow -> StagingPanel -> App -> IPC -> DiffPanel
  - Click-to-diff wired end-to-end: CommitRow -> CommitGraph -> App -> IPC -> DiffPanel
  - Toggle layout: DiffPanel replaces CommitGraph in center pane (never split)
  - DiffPanel close button (X) returns to graph view
  - Deselect-to-close: clicking selected file or commit again hides DiffPanel
  - Selection cleared on repo close (close_repo)

affects: [future-phases]

tech-stack:
  added: []
  patterns:
    - "Toggle layout pattern: {#if selected} <DiffPanel /> {:else} <CommitGraph /> {/if} inside shared flex-1 wrapper"
    - "refetchFileDiff() separate from handleFileSelect() to avoid toggle side effect during repo-changed refresh"
    - "clearDiff() extracted helper centralizes all four state resets (selectedFile, selectedCommitOid, diffFiles, diffCommitDetail)"

key-files:
  created: []
  modified:
    - src/components/FileRow.svelte
    - src/components/CommitRow.svelte
    - src/components/CommitGraph.svelte
    - src/components/StagingPanel.svelte
    - src/App.svelte
    - src/components/DiffPanel.svelte

key-decisions:
  - "DiffPanel replaces CommitGraph in center pane (toggle, not split) — user feedback found split pane confusing"
  - "Deselect-to-close implemented as toggle in handleFileSelect/handleCommitSelect — clicking selected item calls clearDiff()"
  - "refetchFileDiff() introduced to bypass toggle logic when repo-changed fires and selected file needs a live re-fetch"
  - "DiffPanel onclose prop (required, not optional) makes the close contract explicit at the call site"

patterns-established:
  - "Toggle layout: selection state drives {#if} between two full-height panels inside one flex-1 wrapper"
  - "Toggle-to-deselect: handler checks current selection before setting new one; match -> clearDiff(), no match -> proceed"

requirements-completed: [DIFF-01, DIFF-02, DIFF-03, DIFF-04]

duration: 30min
completed: 2026-03-07
---

# Phase 6 Plan 03: Diff Integration Summary

**Click-to-diff wired end-to-end with toggle layout — clicking any file or commit replaces the graph with DiffPanel; X button or re-click returns to graph**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-03-07T20:20:00Z
- **Completed:** 2026-03-07T21:00:00Z
- **Tasks:** 3 (2 auto + 1 human-verify with post-verification fix)
- **Files modified:** 6

## Accomplishments

- Wired click events from FileRow (via StagingPanel) and CommitRow (via CommitGraph) up through App.svelte, which fetches diffs via IPC and passes them to DiffPanel
- Replaced split-pane layout with toggle: CommitGraph and DiffPanel occupy the same flex-1 center column; only one is visible at a time
- Added X close button to DiffPanel and deselect-to-close toggle behavior so users can return to the graph without clicking elsewhere

## Task Commits

1. **Task 1: Add onclick/onselect props to FileRow, CommitRow, CommitGraph, StagingPanel** - `56a6d45` (feat)
2. **Task 2: Wire DiffPanel in App.svelte — selection state, IPC fetch, layout** - `e7df199` (feat)
3. **Task 3 fix: Toggle layout, close button, deselect-to-close** - `e27203a` (fix)

## Files Created/Modified

- `src/components/FileRow.svelte` - Added optional `onclick` prop; cursor changes to pointer when provided
- `src/components/CommitRow.svelte` - Added optional `onselect` prop; clicking fires `onselect(commit.oid)`
- `src/components/CommitGraph.svelte` - Added `oncommitselect` prop; passed down to CommitRow via renderItem snippet
- `src/components/StagingPanel.svelte` - Added `onfileselect` prop; wired to unstaged, staged, and conflicted FileRow instances
- `src/App.svelte` - Selection state, IPC fetch handlers, toggle layout, clearDiff(), refetchFileDiff()
- `src/components/DiffPanel.svelte` - Added required `onclose` prop + X button toolbar; restructured to flex column with scrollable inner div

## Decisions Made

- **Toggle not split:** Human review found the split pane (DiffPanel next to CommitGraph) confusing with no way to close. Changed to a toggle where DiffPanel takes over the full center column.
- **deselect-to-close:** Clicking the same file/commit again calls `clearDiff()` and returns to graph — no separate "deselect" affordance needed.
- **refetchFileDiff() bypass:** The `repo-changed` event handler must re-fetch the current file diff without triggering the deselect toggle. Extracted `refetchFileDiff()` to call IPC directly, keeping selection state intact.
- **onclose required (not optional):** DiffPanel's `onclose` prop is required so TypeScript enforces that every mount site provides a close handler.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Layout toggle and close button — post-verification redesign**
- **Found during:** Task 3 (human-verify)
- **Issue:** The original plan placed DiffPanel as a 4th fixed-width column to the right of CommitGraph. Human review revealed: no way to close diff, panel too narrow due to split, confusing that graph and diff are shown simultaneously.
- **Fix:** Changed layout to toggle (DiffPanel replaces CommitGraph inside shared flex-1 wrapper). Added `onclose` prop + X button to DiffPanel. Added toggle-to-deselect in handleFileSelect/handleCommitSelect. Extracted `refetchFileDiff()` to bypass toggle during repo-changed refresh.
- **Files modified:** `src/App.svelte`, `src/components/DiffPanel.svelte`
- **Commit:** `e27203a` (fix(06-03))

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug/UX regression found during human verify)
**Impact on plan:** The change is structural (layout approach) but contained entirely to App.svelte and DiffPanel.svelte. All DIFF-01 through DIFF-04 requirements remain satisfied. No scope creep.

## Issues Encountered

None beyond the layout deviation documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 6 (diff-display) is complete: Rust diff commands, DiffPanel renderer, and end-to-end wiring are all done
- All DIFF-01 through DIFF-04 requirements satisfied
- The toggle layout pattern is established and can be reused for future detail panels

---
*Phase: 06-diff-display*
*Completed: 2026-03-07*
