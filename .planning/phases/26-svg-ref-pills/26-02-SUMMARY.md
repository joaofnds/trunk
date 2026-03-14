---
phase: 26-svg-ref-pills
plan: 02
subsystem: graph-overlay
tags: [svg, ref-pills, capsule-rects, connectors, hover-expand, dimming, overflow-badge]

requires:
  - phase: 26-svg-ref-pills
    provides: OverlayRefPill data pipeline, buildRefPillData, measureTextWidth, extended getVisibleOverlayElements
provides:
  - SVG ref pill rendering with capsule shapes, lane colors, and text truncation
  - Connector lines from pill to commit dot
  - Remote-only dimming (67%) and non-HEAD darkening (brightness 0.75)
  - Overflow +N badge with hover expansion showing all refs
  - SVG path icons for Tag (diamond) and Stash (flag) ref types
  - Clean CommitRow without HTML pill remnants
affects: []

tech-stack:
  added: []
  patterns: [SVG overlay pill layer with pointer-events for hover, HTML hover overlay for expansion, translate-based graph group offset]

key-files:
  created: []
  modified:
    - src/components/CommitGraph.svelte
    - src/components/CommitRow.svelte

key-decisions:
  - "SVG expanded to cover ref+graph columns with translate offset for existing graph groups"
  - "HTML hover overlay sibling to SVG for multi-ref expansion (clip-path 180ms animation)"
  - "Connector line uses commitColorIndex (lane color) not ref colorIndex"
  - "CommitRow ref column replaced with empty spacer div; RefPill.svelte preserved as dead code"

patterns-established:
  - "Multi-column SVG overlay: expand width, translate existing groups, add new groups at x=0"
  - "SVG pointer-events='auto' on specific elements within pointer-events='none' SVG container"

requirements-completed: [PILL-01, PILL-02, PILL-03, PILL-04]

duration: 3min
completed: 2026-03-14
---

# Phase 26 Plan 02: SVG Ref Pill Rendering Summary

**SVG capsule-shaped ref pills with lane-colored backgrounds, horizontal connector lines, remote dimming, overflow +N badges, hover expansion, and SVG icons for tags/stashes — HTML pills fully removed from CommitRow**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-14T13:49:00Z
- **Completed:** 2026-03-14T13:52:22Z
- **Tasks:** 2 (+ 1 auto-approved checkpoint)
- **Files modified:** 2

## Accomplishments
- SVG ref pills render as capsule rects with lane-colored backgrounds in the overlay
- Connector lines run horizontally from pill right edge to commit dot using commit's lane color
- Remote-only pills dimmed at 67% opacity; non-HEAD pills at brightness(0.75); HEAD at full brightness with bold text
- Overflow +N badge with darkened brightness(0.65) triggers hover expansion showing all refs
- SVG path icons: diamond for Tag, flag for Stash
- HTML ref pills, connector div, and +N badge completely removed from CommitRow
- CommitRow simplified from 143 to 86 lines (-40%)

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire pill pipeline into CommitGraph SVG overlay and add hover expansion** - `116a769` (feat)
2. **Task 2: Remove HTML ref pills from CommitRow and clean up** - `5bb1b69` (refactor)

## Files Created/Modified
- `src/components/CommitGraph.svelte` - Added pill imports/computation, expanded SVG width, translate-offset graph groups, fourth overlay-pills layer with capsule rects/connectors/icons/text/badges, HTML hover overlay
- `src/components/CommitRow.svelte` - Removed RefPill import, allRemoteOnly/refContainerWidth/refHovered state, entire ref column block; replaced with empty spacer div

## Decisions Made
- SVG expanded to cover ref+graph columns with translate offset for existing graph groups — avoids nested SVGs, keeps single coordinate space
- HTML hover overlay as sibling to SVG (not inside SVG) for multi-ref expansion — better text rendering and CSS animation support
- Connector line uses commitColorIndex (commit's lane color) not ref's colorIndex — visual consistency with graph edges
- CommitRow ref column replaced with empty spacer div to preserve layout alignment; RefPill.svelte preserved as dead code for reference

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SVG ref pill system complete — all 4 PILL requirements implemented
- Phase 26 (SVG Ref Pills) complete — both data pipeline and rendering done
- Ready for milestone verification and any follow-up phases

## Self-Check: PASSED

All key files exist on disk, all commit hashes verified in git log.

---
*Phase: 26-svg-ref-pills*
*Completed: 2026-03-14*
