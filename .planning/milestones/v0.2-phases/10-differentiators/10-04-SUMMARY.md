---
phase: 10-differentiators
plan: 04
subsystem: ui
tags: [svelte, css, layout, connector-line, overflow-pill, wip-line, column-dividers, visual-regression]

# Dependency graph
requires:
  - phase: 10-differentiators (10-03)
    provides: Connector line as absolute-positioned div, WIP dotted line unclipped, visible resize handles
provides:
  - Connector line dynamically positioned after pill container using bind:clientWidth
  - Remote-only connector line dimmed at 50% opacity matching pill
  - Overflow +N count styled as bordered pill
  - WIP dotted line visible through HEAD row hover via graph column z-index
  - Subtle 1px right-border column dividers on all data columns except SHA
  - Horizontal padding on text-bearing columns
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "bind:clientWidth for measuring dynamic content width and computing sibling element positioning"
    - "Derived allRemoteOnly boolean for coordinating opacity across connector line and pills"

key-files:
  created: []
  modified:
    - src/components/CommitRow.svelte
    - src/components/RefPill.svelte

key-decisions:
  - "Connector line left offset uses 8px (row px-2 padding) + measured refContainerWidth for precise positioning after pills"
  - "Column dividers use inline border-right style rather than pseudo-elements for simplicity and consistency"

patterns-established:
  - "Use bind:clientWidth on inner wrapper to measure dynamic content and position adjacent absolute elements"

requirements-completed: [DIFF-01, DIFF-02]

# Metrics
duration: 2min
completed: 2026-03-09
---

# Phase 10 Plan 04: UAT Visual Fixes Summary

**Five UAT gap fixes: connector line positioned after pills with remote-only dimming, overflow +N styled as bordered pill, WIP line z-index fix, and column dividers with cell padding**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-10T01:21:54Z
- **Completed:** 2026-03-10T01:23:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Connector line starts precisely after the pill container width instead of from left:0, eliminating overshoot
- Remote-only commits dim both pill (existing) and connector line at 50% opacity
- Overflow +N count renders as a small bordered pill with background and rounded corners instead of plain text
- Graph column receives relative z-[1] so WIP dotted line SVG overflow renders above hover background
- All data row columns (ref, graph, message, author, date) show subtle 1px right border dividers; SHA column excluded
- Text-bearing columns have px-1 horizontal padding so text does not rub against dividers

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix connector line positioning, dimming, overflow pill, WIP hover, and column dividers** - `f3b9591` (fix)
2. **Task 2: Verify visual fixes** - Auto-approved (checkpoint:human-verify, auto mode)

## Files Created/Modified
- `src/components/CommitRow.svelte` - Added allRemoteOnly derived, refContainerWidth with bind:clientWidth, dynamic connector line left/width, graph column z-[1], column dividers, cell padding
- `src/components/RefPill.svelte` - Overflow +N span restyled as bordered pill with background, rounded corners, and smaller font

## Decisions Made
- Connector line left offset computed as 8px (row px-2 padding) + measured refContainerWidth -- this ensures the line starts right after pills regardless of pill content width
- Column dividers implemented as inline border-right on each column div rather than pseudo-elements -- simpler, more consistent with existing inline style pattern

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All five UAT visual gaps addressed (connector line overshoot, remote-only dimming, overflow pill styling, WIP hover line, column dividers with padding)
- Phase 10 differentiators gap closure complete

---
*Phase: 10-differentiators*
*Completed: 2026-03-09*
