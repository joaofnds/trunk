# Phase 20: Foundation — Types, Constants & Overlay Container - Context

**Gathered:** 2026-03-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove SVG-inside-virtual-list overlay with native scroll sync and pointer passthrough. Define new TypeScript types (`GraphNode`, `GraphEdge`, `GraphData`) and updated constants (`ROW_HEIGHT`, `LANE_WIDTH`, `DOT_RADIUS`). This is a decision gate — if the overlay approach fails, stop and consult before fallback.

</domain>

<decisions>
## Implementation Decisions

### Rendering approach
- Raw SVG with Svelte 5 reactivity — zero visualization dependencies
- No D3, Canvas, SVG.js, or any other library — all capabilities are browser primitives
- SVG elements rendered declaratively via Svelte `{#each}` over visible range
- `pointer-events: none` on SVG root, `pointer-events: auto` on individually interactive elements (ref pills in Phase 26)

### Virtual list vendoring
- Vendor `@humanspeak/svelte-virtual-list` into `src/components/` (single file, ~1700 lines)
- Trim to essentials — strip unused features (horizontal scrolling, grid mode, sticky headers) to reduce complexity
- Add an overlay slot inside the scroll container for the SVG element
- This gives full control over the scroll container DOM structure

### Overlay placement
- SVG lives inside the scroll container (scrolls natively with content — zero JS scroll sync)
- SVG is positioned absolute within the scrollable content area, sized to full content height
- HTML commit rows handle all click/right-click interactions beneath the SVG

### Updated graph dimensions
- `ROW_HEIGHT`: 26px → 36px (38% increase — breathing room for bezier curves and ref pills)
- `LANE_WIDTH`: 12px → 16px (proportional increase for curve spacing)
- `DOT_RADIUS`: Claude's discretion (current 6px fills the entire lane; smaller relative to 16px lane is preferred)
- **Define new constants in Phase 20, apply in Phase 24** — current rendering pipeline keeps old values until integration phase

### Decision gate criteria
- **Both scroll performance AND pointer passthrough must pass** — either failing is a deal-breaker
- Scroll: smooth 60fps scrolling with SVG overlay present, no visible jank
- Pointer: clicks and right-clicks reliably reach HTML commit rows beneath the SVG
- Test on your normal repos (not a specific benchmark)
- **If gate fails: stop and consult** — do not auto-fallback. Discuss what went wrong before committing to enhanced per-row viewBox

### Claude's Discretion
- Exact dot radius value (within the "smaller relative to lane" preference)
- Exact SVG element placement within the vendored scroll container DOM
- Which virtual list features to trim vs keep during vendoring
- Edge stroke widths and visual constants not specified above
- How to structure the overlay slot API in the vendored component

</decisions>

<specifics>
## Specific Ideas

- The overlay SVG should feel invisible — it's a rendering layer, not a UI element. It should not affect scrolling feel at all.
- GitKraken proportions (~36-40px rows, proportionally smaller dots) are the visual reference for the new dimensions.
- The vendored virtual list should be simplified enough that it's easy to understand and maintain, not a black box.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@humanspeak/svelte-virtual-list` (node_modules): Source to vendor and simplify. Core scroll logic reusable; trim grid/horizontal/sticky features.
- `graph-constants.ts`: Current constants (LANE_WIDTH=12, ROW_HEIGHT=26, DOT_RADIUS=6) — will be updated with new values.
- `GraphCell.svelte`: Current per-row SVG renderer — reference for how SVG integrates with virtual list rows.
- `computeGraphSvgData()` in `graph-svg-data.ts`: Current path computation — continues working during transition.
- `types.ts`: Existing GraphCommit, GraphEdge, SvgPathData types — new overlay types extend this file.

### Established Patterns
- `$derived.by()` for imperative reactive computations — use for visible SVG element filtering
- Svelte context with getter pattern (`setContext('key', { get data() { ... } })`) — use for overlay data flow
- `safeInvoke<T>` for all Rust IPC — no changes needed
- Three-layer SVG z-ordering (rails → edges → dots) — carry forward into overlay
- Sentinel OID prefix check (`startsWith('__')`) for WIP/stash detection

### Integration Points
- `CommitGraph.svelte:419-430`: Virtual list usage — will switch to vendored component
- `CommitGraph.svelte:267-269`: `graphSvgData` computation — continues working, overlay uses same data
- `.virtual-list-viewport` (scroll container): The element the SVG must sit inside for native scroll sync
- `.virtual-list-content` (full-height div): Sized to `contentHeight` px — SVG overlay matches this height

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 20-foundation-types-constants-overlay-container*
*Context gathered: 2026-03-13*
