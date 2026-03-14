# Phase 26: SVG Ref Pills - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Ref pills render as SVG elements with lane-colored backgrounds, connector lines, remote dimming, and overflow badges — replacing HTML ref pills in the graph column. Requirements: PILL-01, PILL-02, PILL-03, PILL-04. Highest-risk SVG element — HTML fallback ready if SVG text layout limitations block delivery.

</domain>

<decisions>
## Implementation Decisions

### Overflow handling
- 1 pill + separate darkened +N badge (not inline count)
- On hover (pill or +N badge), the pill expands to show all ref names, one per line — GitKraken style
- Smooth expand animation (~150-200ms)
- Claude's discretion on implementation approach (HTML overlay vs pure SVG expansion)

### Pill display density
- 1 pill visible + overflow badge (same as current)
- Ref column stays at 120px default (still user-resizable)
- Long pill text truncated with ellipsis ("feature/long-b…")
- HEAD branch gets first priority as the visible pill; other refs go to overflow

### Connector line appearance
- Straight horizontal SVG line from pill right edge to commit dot (no curve)
- Thickness matches EDGE_STROKE (1.5px)
- Connector uses commit's lane color (not the displayed ref's color)
- Connector inherits pill dimming rules: 50→65% opacity for remote-only, brightness(0.75) for non-HEAD

### Ref type visual distinctions
- Replace unicode prefixes (◆, ⚑) with small SVG path icons for tags and stashes
- Remote branch dimming: softer at 65-70% opacity (up from 50%)
- Non-HEAD branch darkening: keep brightness(0.75)
- Pill shape: capsule (fully rounded ends — rx/ry = half pill height)

### Claude's Discretion
- Hover expansion implementation (HTML overlay positioned over SVG vs pure SVG solution)
- SVG icon designs for tag and stash prefixes
- Exact pill padding, font size, and text positioning within SVG rect
- Text measurement approach for truncation (Canvas measureText or other)
- How ref pill data flows through the overlay pipeline (new type, visibility filtering)
- z-ordering of ref pill layer relative to rails/connections/dots

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RefPill.svelte`: Current HTML ref pill — reference for styling (11px font, rounded-full, px-1.5 py-0, lane-colored background)
- `CommitRow.svelte` (lines 55-101): Current connector line div and +N overflow badge with clip-path hover animation
- `laneColor()` helper: `(idx: number) => var(--lane-${idx % 8})` — reuse for SVG fill/stroke
- `graphOverlay` snippet in `CommitGraph.svelte`: Three-layer SVG rendering pattern — add fourth `<g>` for ref pills
- `getVisibleOverlayElements()`: Visibility filtering by row range — extend or add parallel filter for pills
- `buildGraphData()` / `active-lanes.ts`: Already has access to `GraphCommit.refs` — can extract ref pill data
- 8-color lane palette: CSS custom properties `--lane-0` through `--lane-7` in `app.css`

### Established Patterns
- Heavy computation as `$derived` outside snippet; cheap filtering inside snippet on scroll
- Three `<g>` groups enforce SVG z-ordering — ref pills become a fourth layer
- `pointer-events: none` on SVG root, `pointer-events: auto` on interactive elements (Phase 20 decision)
- Coordinate helpers: `cx(col) = col * LANE_WIDTH + LANE_WIDTH / 2`, `cy(row) = row * ROW_HEIGHT + ROW_HEIGHT / 2`
- Canvas `measureText()` approach documented in STACK.md research for text width measurement

### Integration Points
- `CommitRow.svelte`: Remove HTML RefPill component, connector div, and +N badge from ref column
- `CommitGraph.svelte`: Add ref pill SVG layer to overlay snippet; compute pill data from graphData nodes
- `overlay-visible.ts`: Add ref pill filtering for virtualization (only visible-range pills rendered)
- `types.ts`: New type for SVG ref pill data (position, label, color, overflow count)
- `store.ts`: Column widths — ref column default stays 120px

</code_context>

<specifics>
## Specific Ideas

- "Just like GitKraken" — pill + darkened +N badge, hover expands to show all refs one per line with smooth animation
- Capsule shape (rounded ends) matches current HTML pills — visual continuity
- SVG icons instead of unicode prefixes for tags/stashes — more polished look
- Remote dimming softened to 65-70% — less harsh while still distinguishable

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 26-svg-ref-pills*
*Context gathered: 2026-03-14*
