---
phase: 22-bezier-path-builder
plan: "01"
subsystem: api
tags: [svg, bezier, geometry, overlay, vitest, tdd]

# Dependency graph
requires:
  - phase: 21-active-lanes-transformation
    provides: OverlayEdge[], OverlayGraphData, OverlayNode types and buildGraphData()
  - phase: 20-foundation-types-constants-overlay-container
    provides: OVERLAY_* constants in graph-constants.ts, OverlayNode/OverlayEdge types

provides:
  - buildOverlayPaths(data: OverlayGraphData): OverlayPath[] pure function
  - OverlayPath interface (d, colorIndex, dashed, kind) in types.ts
  - Rail paths: M...V vertical lines with branch-tip termination at cy
  - Connection paths: Manhattan-routed cubic bezier C rounded corners

affects: [23-overlay-renderer, 24-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fixed corner radius R=8px (OVERLAY_LANE_WIDTH/2) for all connection distances"
    - "Kappa constant κ=4(√2-1)/3 for cubic bezier quarter-circle approximation"
    - "hSign/vSign directional multipliers unify 4 corner variants into 1 formula"
    - "isMergePattern() infers curve direction from rail presence at target column"
    - "Branch-tip awareness: isBranchTip nodes terminate rails at cy instead of row boundary"

key-files:
  created:
    - src/lib/overlay-paths.ts
    - src/lib/overlay-paths.test.ts
  modified:
    - src/lib/types.ts

key-decisions:
  - "Used OverlayGraphData (not just OverlayEdge[]) as input — needed for nodes to detect branch tips"
  - "Corner direction inferred from rail edges at target column, not from edge type field"
  - "Fallback for unknown direction: fork (curves up) — safer visual default"
  - "hSign/vSign directional multipliers reduce 4 bezier branches to 1 formula"

patterns-established:
  - "Coordinate helpers cx/cy/rowTop/rowBottom replicated per module (not shared import)"
  - "Pure function: OverlayGraphData in → OverlayPath[] out, no side effects"
  - "kind field ('rail' | 'connection') for z-order layering in Phase 23 renderer"

requirements-completed: [CURV-01, CURV-02, CURV-04]

# Metrics
duration: 3min
completed: 2026-03-14
---

# Phase 22 Plan 01: Bezier Path Builder Summary

**buildOverlayPaths() pure function: cubic bezier Manhattan routing with fixed 8px corner radius, branch-tip rail termination, and direction-inferred merge/fork corners**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-14T04:12:37Z
- **Completed:** 2026-03-14T04:16:09Z
- **Tasks:** 3 (RED → GREEN → REFACTOR)
- **Files modified:** 3

## Accomplishments

- `buildOverlayPaths(data: OverlayGraphData): OverlayPath[]` pure function implementing SVG path generation for the overlay pipeline
- Rail paths with branch-tip awareness: opens/terminates at `cy` (dot center) instead of row boundary for clean branch visuals
- Connection paths with fixed 8px cubic bezier corners: hSign/vSign multipliers unify all 4 directional variants into a single formula
- 34 tests covering all edge cases: rail geometry, connection commands, branch-tip termination, colorIndex/dashed passthrough, WIP geometry parity
- `OverlayPath` interface added to `types.ts` extending `SvgPathData` with `kind: 'rail' | 'connection'`

## Task Commits

TDD plan — 3 commits (one per phase):

1. **RED: Failing tests** - `92aa839` (test)
2. **GREEN: Implementation** - `b982af3` (feat)
3. **REFACTOR: Consolidate formula** - `7333bbc` (refactor)

## Files Created/Modified

- `src/lib/types.ts` — Added `OverlayPath` interface (`d, colorIndex, dashed, kind`)
- `src/lib/overlay-paths.ts` — `buildOverlayPaths()` with rail/connection dispatch, coordinate helpers, bezier math
- `src/lib/overlay-paths.test.ts` — 34 tests: rail geometry, branch tips, connection paths, fixed radius, dashed passthrough

## Decisions Made

- **OverlayGraphData as input (not OverlayEdge[])**: The CONTEXT.md specified `buildOverlayPaths(edges: OverlayEdge[])` but the plan's implementation section explicitly calls out needing nodes for branch tip detection. Used `OverlayGraphData` as input — consistent with `buildGraphData()` pattern.
- **Corner direction via rail inspection**: Rather than adding a direction field to `OverlayEdge`, infer merge vs fork from whether a rail in the target column starts or ends at the connection row. Clean separation of concerns.
- **hSign/vSign formula**: During REFACTOR, consolidated 4 directional branches into 1 formula using signed multipliers — reduces code from ~60 to ~30 lines with identical behavior.

## Deviations from Plan

None - plan executed exactly as written.

The one minor note: CONTEXT.md mentioned `buildOverlayPaths(edges: OverlayEdge[])` as the API, but the PLAN's `<implementation>` section explicitly specified `buildOverlayPaths(data: OverlayGraphData)` to support branch-tip node lookups. The PLAN took precedence.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `buildOverlayPaths()` is the data bridge Phase 23's SVG renderer needs
- Output shape: `OverlayPath[]` with `d`, `colorIndex`, `dashed`, `kind` — ready to render
- `kind: 'rail' | 'connection'` enables z-order layering (rails behind connections behind dots)
- Ready for Phase 23: Overlay SVG Renderer

---
*Phase: 22-bezier-path-builder*
*Completed: 2026-03-14*
