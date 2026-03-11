---
phase: quick-8
plan: 01
subsystem: ui
tags: [svelte, css-transition, animation, overflow-pill]

requires: []
provides:
  - Smooth CSS expand/collapse animation for the overflow pill expanded overlay
affects: [CommitRow]

tech-stack:
  added: []
  patterns: [CSS max-width/max-height/opacity transition for show/hide instead of Svelte {#if} hard DOM insert/remove]

key-files:
  created: []
  modified:
    - src/components/CommitRow.svelte

key-decisions:
  - "Always-in-DOM overlay with CSS transition replaces {#if refHovered} hard show/hide"
  - "Top-left anchor: overlay uses top-1 left-1 instead of top-1/2 -translate-y-1/2 to pin expansion origin"
  - "pointer-events toggled to none when collapsed to prevent invisible overlay intercepting clicks"

patterns-established:
  - "CSS show/hide pattern: render always in DOM, animate with max-width/max-height/opacity, pointer-events:none when collapsed"

requirements-completed: [QUICK-8]

duration: 3min
completed: 2026-03-10
---

# Quick Task 8: Overflow Pill Expand Animation Anchor To Summary

**CSS max-width/max-height/opacity transition on the overflow pill expanded overlay, anchored top-left and expanding right and downward**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-10T00:00:00Z
- **Completed:** 2026-03-10T00:03:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Replaced `{#if refHovered && commit.refs.length > 1}` hard DOM insert/remove with always-in-DOM overlay
- Overlay now smoothly expands right and downward from the top-left anchor on hover
- Smooth collapse on mouse leave via reverse CSS transition
- No layout shift: collapsed view (first pill + +N badge) stays rendered at all times

## Task Commits

1. **Task 1: Animate overflow pill overlay with top-left anchor CSS transition** - c685e32

## Files Created/Modified
- `src/components/CommitRow.svelte` - Replaced hard Svelte if/else show/hide with always-in-DOM overlay using CSS max-width/max-height/opacity transitions

## Decisions Made
- Used always-in-DOM pattern (CSS show/hide) instead of Svelte `{#if}` so CSS transitions can animate the enter/exit states — `{#if}` hard-inserts/removes DOM nodes so there is no CSS state to transition from
- Anchor changed from `top-1/2 -translate-y-1/2` to `top-1` so the top-left corner stays fixed and expansion goes right/down
- `pointer-events: none` when collapsed prevents the invisible (zero-size) overlay from blocking row clicks

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness
- Animation ready for UAT
- User must verify smooth expand/collapse on a commit row with multiple refs before commit is created

---
*Phase: quick-8*
*Completed: 2026-03-10*
