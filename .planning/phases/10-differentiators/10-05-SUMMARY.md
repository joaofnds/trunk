---
phase: 10-differentiators
plan: 05
subsystem: ui
tags: [svelte, context-menu, column-visibility, persistence, lazystore]

# Dependency graph
requires:
  - phase: 10-differentiators (10-04)
    provides: Column dividers, resize handles, header row layout
provides:
  - HeaderContextMenu component with column toggle checkboxes
  - ColumnVisibility interface with LazyStore persistence
  - Conditional column rendering in header and data rows
  - Message column locked as always-visible (required)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fixed-position context menu triggered by oncontextmenu with click-outside and Escape close"
    - "ColumnVisibility interface follows same getter/setter/LazyStore pattern as ColumnWidths"

key-files:
  created:
    - src/components/HeaderContextMenu.svelte
  modified:
    - src/lib/store.ts
    - src/components/CommitGraph.svelte
    - src/components/CommitRow.svelte

key-decisions:
  - "ColumnVisibility follows exact same LazyStore persistence pattern as ColumnWidths for consistency"
  - "Message column checkbox disabled in menu (always visible) since it is the primary data column"
  - "Connector line hidden together with ref column since it spans from ref pills to graph dot"

patterns-established:
  - "Context menu pattern: fixed-position div at mouse coordinates with svelte:window click-outside and Escape handlers"

requirements-completed: [DIFF-02]

# Metrics
duration: 2min
completed: 2026-03-09
---

# Phase 10 Plan 05: Header Context Menu and Column Visibility Summary

**Right-click context menu on header row with per-column visibility toggles persisted via LazyStore**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-10T01:56:18Z
- **Completed:** 2026-03-10T01:58:51Z
- **Tasks:** 3 (2 auto + 1 checkpoint auto-approved)
- **Files modified:** 4

## Accomplishments
- ColumnVisibility interface added to store with getter/setter following existing ColumnWidths pattern
- HeaderContextMenu component renders fixed-position dropdown with 6 column checkboxes at cursor position
- Message column checkbox is disabled and always checked (cannot be hidden)
- Menu closes on click-outside or Escape keypress
- Header columns conditionally rendered based on visibility state
- Data row columns in CommitRow conditionally rendered matching header visibility
- Connector line hidden when ref column is hidden (grouped together in visibility check)
- Column visibility persists across app restarts via LazyStore

## Task Commits

Each task was committed atomically:

1. **Task 1: Add ColumnVisibility to store and create HeaderContextMenu component** - `9fdfcdf` (feat)
2. **Task 2: Wire context menu into CommitGraph header and add conditional column rendering** - `4bb1282` (feat)
3. **Task 3: Verify context menu and column visibility** - Auto-approved (checkpoint:human-verify, auto mode)

## Files Created/Modified
- `src/lib/store.ts` - Added ColumnVisibility interface, COLUMN_VISIBILITY_KEY, DEFAULT_VISIBILITY, getColumnVisibility(), setColumnVisibility()
- `src/components/HeaderContextMenu.svelte` - New component: fixed-position context menu with column toggle checkboxes
- `src/components/CommitGraph.svelte` - Added oncontextmenu handler on header, columnVisibility state, HeaderContextMenu rendering, conditional header columns, pass columnVisibility to CommitRow
- `src/components/CommitRow.svelte` - Added columnVisibility prop, conditional rendering of ref/graph/author/date/sha columns

## Decisions Made
- ColumnVisibility follows exact same LazyStore persistence pattern as ColumnWidths for consistency
- Message column checkbox disabled in context menu since it is the primary data column and must always be visible
- Connector line hidden together with ref column since the line spans from ref pills to the graph dot

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Header context menu complete with column visibility toggles
- All UAT gap closure plans (10-01 through 10-05) executed
- Phase 10 differentiators fully complete

---
*Phase: 10-differentiators*
*Completed: 2026-03-09*
