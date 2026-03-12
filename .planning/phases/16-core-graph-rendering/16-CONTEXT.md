# Phase 16: Core Graph Rendering - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Render viewBox-clipped continuous SVG paths with commit dots, producing identical visual output to v0.3. Phase 15's `graphSvgData` provides the pre-computed path data. WIP/stash synthetic rows are adapted in Phase 17; ref pills migrate in Phase 18.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion

All implementation decisions are at Claude's discretion. The user trusts technical judgment on all areas below:

**Transition strategy:**
- Whether to replace LaneSvg.svelte entirely or adapt it to consume pre-computed paths
- How to handle WIP/stash rows during Phase 16 (before Phase 17 adapts them) — options include keeping old LaneSvg for sentinels only, or rendering sentinels with a simple fallback
- Whether to create a new component or modify LaneSvg in-place

**Path data threading:**
- How `graphSvgData` (Map<string, SvgPathData> computed in CommitGraph.svelte) reaches each row — prop drilling, Svelte context (setContext/getContext), or row-index-based lookup
- Whether each row receives the full map and filters, or CommitGraph pre-filters per row

**ViewBox clipping approach:**
- How to structure the per-row SVG element — viewBox offset into global Y coordinates vs translated SVG group
- How paths are filtered per visible row (render all paths and let viewBox clip, or only render paths that intersect the row's Y band)
- Three-layer z-stacking preservation (rails → edges → dots) in the new structure

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The key constraints are:
- Visual output must be identical to v0.3 (same colors, routing, dot styles, lane positions)
- Virtual scrolling must remain smooth at 60fps with 5k+ commits
- Three-layer SVG z-stacking (rails → edges → dots) must be preserved

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `computeGraphSvgData()` (graph-svg-data.ts): Pre-computes all path d-strings with absolute Y coordinates — ready for viewBox clipping
- `graph-constants.ts`: LANE_WIDTH (12), ROW_HEIGHT (26), DOT_RADIUS (6), EDGE_STROKE (1), WIP_STROKE (1.5), MERGE_STROKE (2)
- `LaneSvg.svelte`: Current per-row renderer with three-layer structure and buildEdgePath() — reference for visual fidelity
- `graphSvgData` reactive derived (CommitGraph.svelte:259-261): Already wired, computed but not yet consumed

### Established Patterns
- `$derived.by()` for imperative reactive computations
- Three-layer SVG rendering (rails → edges → dots) for correct z-stacking
- Sentinel OID prefix check (`startsWith('__')`) for WIP/stash detection
- `laneColor(idx)` → `var(--lane-${idx % 8})` for 8-color vivid palette

### Integration Points
- `CommitRow.svelte:101-105`: Graph column currently renders `<LaneSvg {commit} {maxColumns} />` — entry point for replacement
- `CommitGraph.svelte:259-261`: `graphSvgData` computed here, needs to flow to row components
- `SvelteVirtualList`: Virtual scrolling wrapper — rows receive commit via renderItem snippet
- `SvgPathData` type (types.ts): `{ d: string; colorIndex: number }` — the data contract from Phase 15

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 16-core-graph-rendering*
*Context gathered: 2026-03-12*
