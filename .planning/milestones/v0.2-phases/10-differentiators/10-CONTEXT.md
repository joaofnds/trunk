# Phase 10: Differentiators - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Branch/tag labels integrate visually with the graph via lane-colored ref pills and connector lines. Users can control column widths through a spreadsheet-style header row with resizable columns. The commit row is expanded to show author, date, and sha as separate columns alongside the existing branch/tag, graph, and commit message columns.

</domain>

<decisions>
## Implementation Decisions

### Ref pill coloring
- Full background fill with lane color, white text on top (GitKraken-style)
- Tags use same lane color as their commit's lane (distinguished by icon/prefix only, not color)
- Remote refs shown but dimmed (reduced opacity) -- ONLY when remote-only; if a local ref exists on the same commit, the remote pill stays full opacity
- Overflow behavior unchanged: show first pill + "+N" count for additional refs

### Connector line
- Horizontal line from ref pill right edge directly to the commit dot, using the lane color
- Line stays on the same row as the pill and dot
- Connector lines are contained within the graph column (graph column includes connector space)
- Pill component itself stays as-is -- no structural changes to RefPill beyond adding lane color

### Column layout
- Fixed header row with column labels: branch/tag | graph | commit message | author | date | sha
- Header is always visible (like a spreadsheet frozen header row)
- All six columns independently resizable via drag handles in the header
- Resize handles between column header borders

### Column widths
- Branch/tag column: fixed 120px default (resizable via header)
- Graph column: includes SVG lanes + connector line space
- SVG keeps natural width (maxColumns * laneWidth) -- doesn't stretch; extra space is padding
- Graph column has min-width to prevent clipping the SVG
- Commit message column: flex-fills remaining space
- Author, date, sha: reasonable defaults (Claude's discretion on initial widths)

### Width persistence
- Column widths persist globally across repos using LazyStore pattern
- Same approach as existing left/right pane width persistence in store.ts

### Claude's Discretion
- Resize handle visual style (thin divider, hover effect, cursor)
- Initial default widths for author, date, sha columns
- Min/max width constraints per column
- How connector line renders in SVG (part of LaneSvg or separate element)
- Header row styling (height, font, background color)

</decisions>

<specifics>
## Specific Ideas

- "Keep a row at the top with the labels of the graph sections, like a fixed header in a spreadsheet. We'll resize through there."
- Ref pills stay exactly as they are -- only add lane coloring and the horizontal connector line
- "I didn't ask to change the pill itself. It is working great and should stay as is."
- Remote dimming rule: remote-only refs get reduced opacity; when a local ref shares the same commit, the remote pill stays full opacity
- GitKraken remains the visual reference for lane-colored pills

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RefPill.svelte`: Existing pill component with type-based coloring -- needs lane color override, NOT structural changes
- `laneColor()` in `LaneSvg.svelte`: Maps `color_index` to `var(--lane-${idx % 8})` -- extract and reuse for pills
- `App.svelte` resize handlers: `startLeftResize()` / `startRightResize()` with mousedown/mousemove/mouseup pattern -- copy for column resizing
- `store.ts` LazyStore: `get()`, `set()`, `save()` pattern with keys like `'left_pane_width'` -- add column width keys
- 8-color palette already defined in `app.css`: `--lane-0` through `--lane-7`

### Established Patterns
- Per-row inline SVG with `overflow: visible` and 0.5px overlap for sub-pixel gaps
- `cx()` helper converts column to x-coordinate, `cy = rowHeight / 2`
- CSS custom properties for lane colors
- Virtual list (`SvelteVirtualList`) with `items={commits}` array

### Integration Points
- `RefLabel` type in Rust backend: Needs `color_index` field added (currently has name, short_name, ref_type, is_head)
- `types.ts`: `RefLabel` interface needs `color_index` field
- `CommitRow.svelte`: Current layout (refs | graph | message) expands to 6 columns with header
- `CommitGraph.svelte`: Needs header row above virtual list, passes column widths to CommitRow
- `GraphCommit` already has author, date, sha data from Rust -- just needs display columns

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 10-differentiators*
*Context gathered: 2026-03-09*
