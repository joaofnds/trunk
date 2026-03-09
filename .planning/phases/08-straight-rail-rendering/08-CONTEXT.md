# Phase 8: Straight Rail Rendering - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Users see continuous vertical colored lines connecting commits in each branch, with all active lanes drawn through every row. Merge/fork connections use horizontal-then-vertical routing with rounded corners. Bezier S-curves are Phase 9; WIP row connection and merge commit visual distinction are Phase 10.

</domain>

<decisions>
## Implementation Decisions

### Lane line style
- Medium weight lines (2.5-3px stroke width)
- Round line caps (stroke-linecap: round)
- Full opacity (1.0) — bold, vivid rails
- GitKraken-style visual reference throughout

### Edge routing (merge/fork connections)
- Manhattan routing with rounded corners — NOT straight diagonals
- Edge path: horizontal out from commit dot → rounded 90° turn at target column → vertical up/down to target commit
- Corner radius: ~6px (half of 12px laneWidth)
- Horizontal edges draw ON TOP of vertical rails they cross (merge edge visually interrupts pass-through rails)
- Edge uses source branch color (color_index from GraphEdge, matching Phase 7 decision)
- Horizontal + vertical segments stay within the row where the connection originates

### Commit dot rendering
- Dot renders on top of rail lines, no gap/ring — rail is continuous behind, dot covers the junction
- Always matches lane color (color_index) — no special HEAD/selected styling
- Uniform size: r=4 for all commits (merge distinction deferred to Phase 10)
- Horizontal merge edges connect to dot center; dot covers the junction point

### Color palette
- Custom dark-theme palette (not GitKraken's exact colors)
- 8 colors cycling (--lane-0 through --lane-7)
- Vivid & saturated — high contrast against dark background
- HEAD (color_index 0) is just the first color in rotation, no special treatment

### Sub-pixel gap handling
- Claude's Discretion — use overflow:visible + overlap or whatever technique best eliminates visible seams between row SVGs at all zoom levels

### Claude's Discretion
- Sub-pixel gap fix technique (overflow:visible + 0.5px overlap or alternative)
- Exact color hex values for the 8-color vivid palette
- SVG element ordering for correct layering (rails → merge edges → dots)
- Edge path construction details (SVG path d-string with arc commands for rounded corners)

</decisions>

<specifics>
## Specific Ideas

- "I want the graph to look exactly like GitKraken's" — GitKraken is the definitive visual reference
- GitKraken uses straight vertical branches with horizontal-then-vertical merge routing (not diagonal lines)
- Reference article: pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html — GitKraken categorized as "one commit per row, straight branches"
- The edge routing described: "lanes should come out of the commit horizontally until they reach the target lane, then they do a rounded 90 degree turn (still on the same row), then they go up straight vertically until they reach the target commit"

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `LaneSvg.svelte`: Currently renders only commit dot (circle). Needs rails + merge edges added. Already receives `commit`, `laneWidth=12`, `rowHeight=26`, `maxColumns`
- `GraphEdge` type: Has `from_column`, `to_column`, `edge_type` (Straight/MergeLeft/MergeRight/ForkLeft/ForkRight), `color_index` — all data needed for rendering
- `laneColor()` helper: Already maps `color_index` to CSS variable `--lane-${idx % 8}`
- `svgWidth` derived: Already computed from `maxColumns * laneWidth`
- SVG already uses `overflow: visible` and `flex-shrink: 0`

### Established Patterns
- Per-row inline SVG (not Canvas/single SVG) — works with virtual scrolling
- CSS custom properties for lane colors: `--lane-0` through `--lane-7`
- `cx()` helper converts column index to x-coordinate: `col * laneWidth + laneWidth / 2`
- `cy` is `rowHeight / 2` (vertical center of row)

### Integration Points
- `CommitRow.svelte`: Already passes `commit` and `maxColumns` to `LaneSvg`
- `CommitGraph.svelte`: Virtual scrolling container — no changes needed
- `types.ts`: `GraphCommit.edges` array already populated by Rust backend
- CSS variables in app theme: `--lane-0` through `--lane-7` need actual vivid color values defined

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-straight-rail-rendering*
*Context gathered: 2026-03-09*
