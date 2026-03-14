# Phase 22: Bezier Path Builder - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Generate SVG path `d` strings from `OverlayEdge[]` — Manhattan-routed edges with cubic bezier rounded corners for cross-lane connections and continuous vertical lines for same-lane rails. This is a pure math/geometry phase producing path data consumed by Phase 23's SVG renderer.

</domain>

<decisions>
## Implementation Decisions

### Curve shape & style
- **GitKraken Manhattan style** — not free-form bezier S-curves. Edges consist of: vertical segments, horizontal segments, and 90° rounded corners at bends
- Branch edges: vertical down → rounded 90° turn → horizontal right
- Merge edges: horizontal left → rounded 90° turn → vertical up
- Corner radius: `OVERLAY_LANE_WIDTH / 2` (8px) — fixed, matching current pipeline proportions
- Horizontal segments sit at row midpoint (cy) — overlapping edges distinguished by color only, no vertical offset
- Paths terminate at **dot center** (cx, cy) — dots render on top in z-order, covering line ends (matches GitKraken reference)
- The "cubic bezier" in CURV-01 refers to using SVG `C` commands for the rounded 90° corners (smoother than SVG arc `A` commands)

### Distance-based tension tuning
- **Fixed corner radius** regardless of row distance — adjacent (1 row gap) and distant (20 row gap) connections use identical 8px corner rounding
- Vertical/horizontal segments simply get longer for distant connections — the corner shape stays the same
- This matches GitKraken behavior observed in reference screenshots

### Rail continuity & termination
- Rails run **full row extent**: `rowTop(fromY)` to `rowBottom(toY)` for the coalesced edge span
- **Exception at branch tips**: when a rail has no continuation beyond a dot (branch start/end), terminate at `cy` (dot center) instead of row boundary — cleaner visual at open ends
- Dashed flag is **passed through** — path builder generates identical geometry for dashed and solid edges. SVG renderer applies `stroke-dasharray` via CSS/attribute. Clean separation of concerns.

### Output shape & API surface
- **Single entry point**: `buildOverlayPaths(edges: OverlayEdge[]): OverlayPath[]`
- Reuse existing `SvgPathData` shape (`{ d: string; colorIndex: number; dashed?: boolean }`) extended with a `kind` field
- Add **`kind: 'rail' | 'connection'`** classification field — renderer uses this for three-layer z-ordering (rails behind connections behind dots)
- Pure function, no side effects — same pattern as `computeGraphSvgData` and `buildGraphData`

### Claude's Discretion
- Exact SVG `C` command control point math for the rounded corners (as long as radius = 8px and corners are 90°)
- Whether to use `C` (cubic bezier) or `Q` (quadratic) for the corner rendering — whichever produces cleaner 90° rounds
- Internal helper organization (coordinate helpers, edge dispatching)
- Test structure and helper factories (follow existing patterns in `active-lanes.test.ts`)
- Edge stroke widths (already defined: `OVERLAY_EDGE_STROKE = 1.5`, `OVERLAY_MERGE_STROKE = 2`)

</decisions>

<specifics>
## Specific Ideas

- GitKraken graph screenshots provided as the definitive visual reference — Manhattan routing with smooth rounded corners, not free-form bezier sweeps
- Dense multi-lane graphs should look clean with edges crossing many lanes at row midpoint, color being the primary visual separator
- The path builder should feel like a coordinate transformation — grid coordinates in, SVG path strings out

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SvgPathData` type in `src/lib/types.ts`: `{ d: string; colorIndex: number; dashed?: boolean }` — extend with `kind` field for overlay paths
- `OverlayEdge` type in `src/lib/types.ts`: `{ fromX, fromY, toX, toY, colorIndex, dashed }` — input type from Phase 21
- `OverlayGraphData` from `buildGraphData()` in `src/lib/active-lanes.ts` — upstream data source
- Overlay constants in `src/lib/graph-constants.ts`: `OVERLAY_LANE_WIDTH=16`, `OVERLAY_ROW_HEIGHT=36`, `OVERLAY_DOT_RADIUS=4`, `OVERLAY_EDGE_STROKE=1.5`, `OVERLAY_MERGE_STROKE=2`

### Established Patterns
- **Coordinate helpers**: `cx(col)`, `cy(row)`, `rowTop(row)`, `rowBottom(row)` — replicated in each module (not shared imports). Adapt to use `OVERLAY_*` constants.
- **Pure function → SvgPathData[]**: `computeGraphSvgData()` in `graph-svg-data.ts` is the legacy equivalent — same pattern, different routing math
- **TDD with Vitest**: exact `d` string assertions, `makeCommit()`/`makeEdge()` factory helpers, `describe` blocks by feature area
- **Edge classification by key**: legacy uses string key patterns (`:straight:`, `:rail:`) — new pipeline uses explicit `kind` field instead

### Integration Points
- **Input**: `OverlayEdge[]` from `buildGraphData()` (Phase 21, `src/lib/active-lanes.ts`)
- **Output consumed by**: Phase 23 SVG renderer — paths rendered inside the overlay `<svg>` in `CommitGraph.svelte` (lines 419-429)
- **Edge shape from Phase 21**: same-lane edges have `fromX === toX`, `fromY < toY` (vertical spans); cross-lane edges have `fromX !== toX`, `fromY === toY` (single row, connection)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 22-bezier-path-builder*
*Context gathered: 2026-03-14*
