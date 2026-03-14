# Phase 24: Integration - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire the overlay SVG pipeline into CommitGraph as the sole rendering path, remove the old per-row GraphCell pipeline (GraphCell.svelte, LaneSvg.svelte, graph-svg-data.ts), unify constants from dual (old + OVERLAY_) to single set, and apply tuned dimensions. Requirements: TUNE-01, TUNE-02.

</domain>

<decisions>
## Implementation Decisions

### Dimension values
- ROW_HEIGHT: 36px (confirmed, no flexibility needed)
- LANE_WIDTH: 16px (confirmed, wider lanes accepted)
- DOT_RADIUS: 6px (bumped from overlay's 4px — same absolute size as old pipeline, proportionally smaller in wider lanes)
- EDGE_STROKE: 1.5px (unified from overlay value)
- MERGE_STROKE: 2px (unchanged)

### Constant unification
- Drop the OVERLAY_ prefix entirely — OVERLAY_LANE_WIDTH becomes LANE_WIDTH, etc.
- Remove the old constant values (LANE_WIDTH=12, ROW_HEIGHT=26, DOT_RADIUS=6, EDGE_STROKE=1)
- Single set of constants in graph-constants.ts — no more dual naming
- Update all imports across the codebase to use the unified names
- graph-constants.test.ts updated to test new values

### Ref connector transition
- Update CommitRow's HTML connector line to use the unified LANE_WIDTH (16px) — automatic alignment with overlay dot positions
- Match connector line thickness to unified EDGE_STROKE (1.5px) for visual consistency with overlay
- Let graph column width flow naturally with wider lanes — no cap or special handling
- Minimal polish — Phase 26 replaces ref connectors with SVG entirely

### Stash dot rendering
- Change from filled square to **hollow dashed square** (rect with fill="none", stroke with dasharray)
- Same stroke width and dash pattern as WIP circle (EDGE_STROKE, dasharray="3 3")
- Only the shape differentiates stash (square) from WIP (circle) — consistent "synthetic row" visual language
- Keep dashed connectors for stash paths (unchanged from Phase 23)

### Claude's Discretion
- Exact order of file deletions and import cleanup
- Whether to delete graph-svg-data.test.ts alongside graph-svg-data.ts (likely yes — tests for deleted code)
- Skeleton loading row height adjustment (currently uses ROW_HEIGHT)
- Any intermediate refactoring steps needed for clean integration

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildGraphData()` (src/lib/active-lanes.ts): Already wired in CommitGraph as `$derived`
- `buildOverlayPaths()` (src/lib/overlay-paths.ts): Already wired in CommitGraph as `$derived`
- `getVisibleOverlayElements()` (src/lib/overlay-visible.ts): Already called inside overlay snippet
- `graphOverlay` snippet in CommitGraph.svelte: Complete three-layer SVG rendering with dot differentiation
- 8-color lane palette: Already defined as CSS custom properties `--lane-0` through `--lane-7` in app.css

### Established Patterns
- Heavy computation (`buildGraphData`, `buildOverlayPaths`) as `$derived` outside snippet — recomputes only on data change
- Cheap visibility filter (`getVisibleOverlayElements`) called inside snippet — recomputes on scroll
- Three `<g>` groups enforce SVG z-ordering: rails → connections → dots
- `laneColor()` helper: `(idx: number) => var(--lane-${idx % 8})` — used in both CommitGraph overlay and CommitRow connector

### Integration Points
- CommitGraph.svelte: Remove `computeGraphSvgData` import, `graphSvgData` derived, and `setContext('graphSvgData', ...)` 
- CommitRow.svelte: Remove `GraphCell` import and `<GraphCell>` usage in graph column; update LANE_WIDTH/EDGE_STROKE to unified values
- CommitGraph.svelte: Update `defaultEstimatedItemHeight` from `ROW_HEIGHT` (26) to new unified value (36)
- CommitGraph.svelte: Update skeleton loading height from `ROW_HEIGHT` to unified value
- CommitGraph.svelte: Update graph column min-width calculation in `startColumnResize`

</code_context>

<specifics>
## Specific Ideas

- v0.2 pending todo "Make commit dot bigger and lanes thinner" is addressed by this phase (6px dots, 16px lanes)
- The hollow dashed square for stash creates a visual taxonomy: normal (filled circle) → merge (hollow circle) → WIP (hollow dashed circle) → stash (hollow dashed square)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 24-integration*
*Context gathered: 2026-03-14*
