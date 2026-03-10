---
phase: quick
plan: 6
subsystem: ui
tags: [svelte, commit-graph, ref-pills, hover]

requires: []
provides:
  - Hover-expand overflow pill in CommitRow ref column revealing all ref pills in a floating overlay
affects: [CommitRow, RefPill]

tech-stack:
  added: []
  patterns: ["showAll prop pattern for conditional full/collapsed rendering in pill components"]

key-files:
  created: []
  modified:
    - src/components/CommitRow.svelte
    - src/components/RefPill.svelte

key-decisions:
  - "showAll prop on RefPill drives collapsed-vs-expanded rendering; avoids duplicating pill markup in CommitRow"
  - "Invisible measure div keeps refContainerWidth stable during hover so connector line offset is unaffected"
  - "overflow-visible on ref column container lets absolute-positioned overlay float over adjacent columns without layout shift"

patterns-established:
  - "Floating overlay via absolute positioning + overflow-visible parent: safe way to expand content beyond column bounds"

requirements-completed: []

duration: 3min
completed: 2026-03-10
---

# Quick Task 6: Branch Overflow Pill Hover-Expand Summary

**Hover over a multi-ref commit's ref column now reveals all branch/tag pills in a floating rounded overlay; mouse-out restores the collapsed first-pill + +N view.**

## Performance

- **Duration:** ~3 min
- **Completed:** 2026-03-10
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added `refHovered` reactive state to `CommitRow.svelte`, toggled by `onmouseenter`/`onmouseleave` on the ref column div
- When hovered with 2+ refs, shows an absolute-positioned floating pill container (rounded, shadowed, elevated background) with all ref pills via `<RefPill showAll={true} />`
- Default collapsed state unchanged: first pill + `+N` overflow badge
- Added `showAll?: boolean` prop to `RefPill.svelte`; when true renders all refs in a `flex gap-1` row without `max-w-[100px] truncate` width restriction
- Kept an invisible measure div bound to `refContainerWidth` during hover so the connector line left offset remains stable

## Task Commits

1. **Task 1: Add hover-expand behavior to the ref column overflow pill** - `154ad71` (feat)

## Files Created/Modified

- `src/components/CommitRow.svelte` - Added `refHovered` state, hover event handlers, conditional expanded/collapsed rendering with floating overlay
- `src/components/RefPill.svelte` - Added `showAll` prop; when true, renders all refs in a flex row with full (non-truncated) pill names

## Decisions Made

- Used a `showAll` prop on `RefPill` rather than inlining the pill loop in `CommitRow` to keep pill rendering logic centralized
- Kept an invisible clone of the default pill container (bound to `refContainerWidth`) during hover state so the connector line calculation (`left: {12 + refContainerWidth}px`) does not jump when the expanded overlay renders
- Used `overflow-visible` on the column container (not `z-index` tricks) so the overlay naturally floats above adjacent content without affecting document flow

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The pre-existing type error in `CommitGraph.svelte` (unrelated `SvelteVirtualListScrollOptions` mismatch) was present before this task and is out of scope.

## Next Phase Readiness

Hover-expand overflow pill is complete and functional. No blockers.

---
*Phase: quick*
*Completed: 2026-03-10*
