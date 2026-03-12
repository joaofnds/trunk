# Phase 15: Graph Data Engine - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Compute continuous SVG path data from the commit graph. One `<path>` d-string per commit-to-commit edge (parent links and merge/fork edges), with Manhattan routing preserved. No visual changes — data layer only. Rendering happens in Phase 16.

</domain>

<decisions>
## Implementation Decisions

### Path generation location
- TypeScript, not Rust — Rust already returns all needed data (GraphCommit with edges, columns, color_index)
- Zero new dependencies — architecture change only

### Rendering approach
- ViewBox-clipped per-row SVGs (not overlay/full-height SVG)
- Each row clips into the continuous paths using viewBox offset

### Claude's Discretion
- **Edge granularity** — whether to generate one path per parent-child link or one continuous path per lane segment. Choose based on what simplifies Phase 16 rendering while keeping path count manageable.
- **Module boundary** — where GraphSvgData lives (new module vs extending existing). Should integrate cleanly with the CommitGraph → CommitRow → LaneSvg pipeline without breaking the current flow.
- **Synthetic row scope** — whether WIP/stash sentinel rows are included in Phase 15 path computation or deferred entirely to Phase 17. Current LaneSvg.svelte handles them as special cases with sentinel OIDs (`__wip__`, `__stash_N__`).
- Reactivity strategy — `$derived.by()` pattern per existing codebase conventions
- Data structure shape for GraphSvgData
- Manhattan routing implementation details (arc radius, segment ordering)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The key constraint is that generated path strings must produce identical visual output when rendered in Phase 16 (same Manhattan routing with horizontal + arc + vertical segments as current LaneSvg.svelte buildEdgePath).

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `LaneSvg.svelte`: Current per-row SVG renderer with `buildEdgePath()` function — Manhattan routing logic to replicate in path generation
- `graph-constants.ts`: LANE_WIDTH (12), ROW_HEIGHT (26), DOT_RADIUS (6), EDGE_STROKE (1) — shared constants for path coordinate math
- `git/graph.rs` (`walk_commits`): Lane algorithm producing GraphCommit with column, color_index, edges (GraphEdge with from_column, to_column, edge_type)
- `git/types.rs`: GraphCommit, GraphEdge, EdgeType (Straight, MergeLeft, MergeRight, ForkLeft, ForkRight), GraphResult

### Established Patterns
- `$derived.by()` for imperative reactive computations (used throughout for derived state)
- Three-layer SVG rendering (rails → edges → dots) — path data should support this layering
- Sentinel OIDs for synthetic rows (`__wip__`, `__stash_N__`)
- `safeInvoke<T>` for all Rust IPC calls

### Integration Points
- GraphCommit[] from `get_commit_graph` / `refresh_commit_graph` IPC calls — input data source
- LaneSvg.svelte — current consumer that will be replaced/adapted in Phase 16
- CommitRow.svelte — passes commit + maxColumns to LaneSvg; will need to pass path data instead
- Virtual list (SvelteVirtualList) — path computation must not block scroll performance

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 15-graph-data-engine*
*Context gathered: 2026-03-12*
