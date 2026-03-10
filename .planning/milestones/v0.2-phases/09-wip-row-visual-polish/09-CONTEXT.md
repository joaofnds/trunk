# Phase 9: WIP Row + Visual Polish - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

The graph distinguishes merge commits visually and connects the WIP row to HEAD. Merge commits display as hollow circles, visually distinct from regular filled-circle commits. When the working tree is dirty, the WIP row connects to the HEAD commit via a dashed lane line. No reduced opacity -- the hollow styling alone provides sufficient visual distinction.

</domain>

<decisions>
## Implementation Decisions

### WIP row connection
- Minimal connector only -- dashed line from WIP dot to HEAD, no full lane rails for other active branches
- Dashed line uses HEAD's lane color (color_index 0)
- WIP dot rendered as a dashed/dotted circle outline, matching the dashed connector line style
- WIP row moves inside the virtual list as the first item (not a separate div above) -- scrolls with commits, dashed line flows seamlessly into HEAD's row below

### Merge commit dot style
- Hollow circle with lane-colored stroke (2px stroke width)
- Inner fill uses background color (--color-bg) -- rail line hidden inside the circle, looks like a clean ring
- Same size as regular dots (r=4) -- hollow styling alone distinguishes them
- `is_merge` already available in GraphCommit from Rust backend

### Merge commit visual treatment
- No reduced opacity anywhere -- VIS-03 intentionally not implemented as opacity reduction
- Merge commit text rendered identically to regular commits (same color, same opacity)
- The hollow dot is the sole visual differentiator for merge commits

### Claude's Discretion
- Dash pattern for WIP line and dot (e.g., stroke-dasharray values)
- How to inject WIP as first virtual list item (synthetic GraphCommit or separate mechanism)
- SVG layering adjustments needed for hollow dot + background fill rendering order

</decisions>

<specifics>
## Specific Ideas

- WIP dashed circle should visually match the dashed connector line -- same dash rhythm creates a cohesive "uncommitted" visual language
- The WIP row moving inside the virtual list means it participates in scrolling, which is important for visual continuity with the HEAD commit below it

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `LaneSvg.svelte`: Three-layer SVG (rails -> edges -> dots). Commit dot at Layer 3 needs conditional hollow rendering for `is_merge` commits
- `CommitGraph.svelte`: WIP row currently a separate div (lines 125-144) with inline SVG. Needs refactoring to inject WIP as first virtual list item
- `GraphCommit.is_merge`: Already computed in `graph.rs:66` and available in frontend type
- `laneColor()` helper: Maps `color_index` to CSS variable -- reusable for merge dot stroke color

### Established Patterns
- Per-row inline SVG with `overflow: visible` and 0.5px overlap for sub-pixel gap prevention
- `cx()` helper converts column to x-coordinate, `cy = rowHeight / 2`
- CSS custom properties for lane colors (--lane-0 through --lane-7)
- Virtual list uses `SvelteVirtualList` with `items={commits}` array

### Integration Points
- `CommitGraph.svelte`: WIP row injection point -- currently separate div, needs to become first item in commits array or handled by virtual list
- `LaneSvg.svelte`: Needs `is_merge` check to render hollow vs filled dot
- `CommitRow.svelte`: May need WIP-specific styling (dashed circle, muted text color)
- `App.svelte`: Passes `wipCount`, `wipMessage`, `onWipClick` to CommitGraph -- interface may change

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 09-wip-row-visual-polish*
*Context gathered: 2026-03-09*
