---
phase: 26-svg-ref-pills
plan: 01
subsystem: graph-overlay
tags: [svg, ref-pills, text-measurement, canvas-measuretext, virtualization]

requires:
  - phase: 20-foundation-types-constants-overlay-container
    provides: OverlayNode, OverlayGraphData, graph-constants
provides:
  - OverlayRefPill interface for SVG pill rendering
  - buildRefPillData() pure function for pill computation
  - measureTextWidth/truncateWithEllipsis text measurement utilities
  - Extended getVisibleOverlayElements with pills filtering
affects: [26-svg-ref-pills]

tech-stack:
  added: [Canvas measureText API (OffscreenCanvas)]
  patterns: [injectable measure function for testability, per-font-string caching]

key-files:
  created:
    - src/lib/text-measure.ts
    - src/lib/text-measure.test.ts
    - src/lib/ref-pill-data.ts
    - src/lib/ref-pill-data.test.ts
  modified:
    - src/lib/types.ts
    - src/lib/graph-constants.ts
    - src/lib/overlay-visible.ts
    - src/lib/overlay-visible.test.ts

key-decisions:
  - "Injectable measureFn parameter for deterministic test behavior (mock: 7px/char)"
  - "OffscreenCanvas for text measurement (no DOM dependency, works in workers)"
  - "Per-font-string cache key format: 'font::text' for collision-free lookup"

patterns-established:
  - "Injectable measurement functions: pass mockMeasure to buildRefPillData/truncateWithEllipsis for testing"
  - "Backward-compatible function extension: optional parameter with default empty array"

requirements-completed: [PILL-01, PILL-02, PILL-03, PILL-04]

duration: 5min
completed: 2026-03-14
---

# Phase 26 Plan 01: Ref Pill Data Pipeline Summary

**TDD-built pure-function pipeline: OverlayRefPill type, text measurement with caching/truncation, buildRefPillData() with sorting/overflow/positioning, and extended visibility filtering**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-14T13:40:18Z
- **Completed:** 2026-03-14T13:45:34Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- OverlayRefPill interface with 17 fields covering position, styling, overflow, and connector data
- Pill constants (PILL_HEIGHT, PILL_PADDING_X, fonts, ICON_WIDTH, etc.) in graph-constants.ts
- Text measurement utility with OffscreenCanvas + per-font caching and ellipsis truncation
- buildRefPillData() transforms OverlayNode[] + GraphCommit[] into positioned, styled pills
- Ref sorting (HEAD first, then LocalBranch > Tag > Stash > RemoteBranch) and remote-only detection
- Extended getVisibleOverlayElements with backward-compatible pills parameter
- 26 new tests (6 text-measure + 17 ref-pill-data + 3 overlay-visible pills), 115 total pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Types, constants, and text measurement utility with tests** - `39e126a` (feat)
2. **Task 2: buildRefPillData() computation and extended visibility filtering with tests** - `9dadff1` (feat)

## Files Created/Modified
- `src/lib/types.ts` - Added OverlayRefPill interface
- `src/lib/graph-constants.ts` - Added pill constants (PILL_HEIGHT, fonts, spacing, etc.)
- `src/lib/text-measure.ts` - Canvas measureText with caching + truncateWithEllipsis
- `src/lib/text-measure.test.ts` - 6 tests for measurement and truncation
- `src/lib/ref-pill-data.ts` - sortRefs, isRemoteOnlyRef, buildRefPillData
- `src/lib/ref-pill-data.test.ts` - 17 tests for sorting, positioning, overflow, styling
- `src/lib/overlay-visible.ts` - Extended with pills parameter and filtering
- `src/lib/overlay-visible.test.ts` - Added 3 pill visibility tests, updated empty-input test

## Decisions Made
- Injectable measureFn parameter for deterministic testing (mock: 7px per character)
- OffscreenCanvas for text measurement — no DOM dependency, works in workers
- Per-font-string cache key format (`font::text`) for collision-free lookup
- Backward-compatible overlay-visible extension via optional `pills` parameter with empty default

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Ref pill data pipeline complete and tested
- Ready for Plan 02 (SVG rendering of ref pills)
- buildRefPillData() ready for integration with CommitGraph.svelte
- getVisibleOverlayElements pills filtering ready for virtualized rendering

---
*Phase: 26-svg-ref-pills*
*Completed: 2026-03-14*
