---
phase: 23-svg-rendering
plan: "02"
subsystem: ui
tags: [svelte, svg, virtual-list, overlay, commit-graph]

# Dependency graph
requires:
  - phase: 23-svg-rendering
    provides: "Plan 01 — OverlayPath minRow/maxRow fields and getVisibleOverlayElements visibility filter"
  - phase: 22-bezier-path-builder
    provides: "buildOverlayPaths() generating OverlayPath[] from OverlayGraphData"
  - phase: 21-active-lanes-transformation
    provides: "buildGraphData() producing OverlayGraphData with nodes/edges"
provides:
  - "Full SVG overlay pipeline wired: displayItems → overlayGraphData → overlayPaths → visible → SVG"
  - "Three-layer z-ordered SVG: overlay-rails behind overlay-connections behind overlay-dots"
  - "Four commit dot types: normal (filled circle), merge (hollow circle), WIP (hollow dashed circle), stash (filled square)"
  - "VirtualList overlaySnippet extended with visibleStart/visibleEnd args for scroll-efficient filtering"
affects: [24-graphcell-removal, phase-24]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Heavy computation (buildGraphData, buildOverlayPaths) as $derived outside snippet — recomputes only on data change"
    - "Cheap visibility filter (getVisibleOverlayElements) called inside snippet — recomputes on scroll"
    - "Three <g> groups enforce SVG z-ordering: rails → connections → dots"

key-files:
  created: []
  modified:
    - src/components/VirtualList.svelte
    - src/components/CommitGraph.svelte

key-decisions:
  - "overlaySnippet signature extended to Snippet<[contentHeight, visibleStart, visibleEnd]> — passes existing visibleItems data to overlay"
  - "getVisibleOverlayElements() called inside snippet (not as $derived) — intentional, scroll-cheap array filtering"
  - "buildGraphData and buildOverlayPaths placed as $derived outside snippet — heavy computation only on data change"
  - "OVERLAY_LANE_WIDTH used for SVG width (not old LANE_WIDTH) — correct constant for overlay coordinate system"

patterns-established:
  - "SVG z-ordering via three named <g> groups: overlay-rails, overlay-connections, overlay-dots"
  - "Dot type precedence: WIP → stash → merge → normal (checked in that order)"

requirements-completed: [CURV-03, DOTS-01, DOTS-02, DOTS-03]

# Metrics
duration: 1min
completed: 2026-03-14
---

# Phase 23 Plan 02: SVG Rendering Summary

**Full overlay pipeline wired into CommitGraph: graphData → bezier paths → visible elements → three-layer SVG with type-differentiated commit dots (normal/merge/WIP/stash)**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-14T04:39:41Z
- **Completed:** 2026-03-14T04:41:05Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Extended VirtualList `overlaySnippet` to pass `visibleStart` and `visibleEnd` from the already-reactive `visibleItems` derived
- Wired full reactive overlay pipeline in CommitGraph: `displayItems → overlayGraphData → overlayPaths` (heavy, data-change only)
- Visibility filtering (`getVisibleOverlayElements`) inside the snippet for scroll-efficient re-evaluation
- Three `<g>` groups enforce correct z-ordering: rails behind connections behind dots
- Four dot shapes differentiate commit types: normal (filled circle), merge (hollow circle), WIP (hollow dashed circle), stash (filled square)

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend VirtualList overlaySnippet signature with visible range** - `b6fe14d` (feat)
2. **Task 2: Wire overlay pipeline and render three-layer SVG in CommitGraph** - `3a8a01e` (feat)

**Plan metadata:** TBD (docs: complete plan)

## Files Created/Modified
- `src/components/VirtualList.svelte` — overlaySnippet type extended to include visibleStart/visibleEnd; render call updated to pass visibleItems.start/end
- `src/components/CommitGraph.svelte` — imports added, laneColor/overlayCx/overlayCy helpers, overlayGraphData/overlayPaths $derived, graphOverlay snippet fully implemented with three <g> groups

## Decisions Made
- `getVisibleOverlayElements()` called directly inside the snippet rather than as a `$derived` — intentional design: the snippet re-renders when scroll args change, which is the desired behavior for cheap scroll-time filtering
- Used `OVERLAY_LANE_WIDTH` (not old `LANE_WIDTH`) for SVG width — correct for the overlay coordinate system
- Old `graphSvgData` and `GraphCell` per-row rendering preserved — removal is Phase 24 work

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full SVG overlay now renders alongside old per-row GraphCell rendering (intermediate state)
- Phase 24 removes GraphCell and the old `graphSvgData` derived
- WebKit SVG performance at scale remains an open research item

---
*Phase: 23-svg-rendering*
*Completed: 2026-03-14*
