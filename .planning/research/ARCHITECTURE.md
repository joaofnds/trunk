# Architecture Research: Full-Height SVG Graph Rework

**Domain:** Graph rendering rework for Tauri 2 + Svelte 5 desktop Git GUI
**Researched:** 2026-03-12
**Confidence:** HIGH -- all integration points derived from reading existing code; no external libraries needed

---

## Existing Architecture (What Must Not Break)

### Virtual List DOM Structure

`@humanspeak/svelte-virtual-list` creates this four-layer DOM:

```
div.virtual-list-container     (position: relative; overflow: hidden)
  div.virtual-list-viewport    (position: absolute; inset: 0; overflow-y: scroll)
    div.virtual-list-content   (position: relative; height: {contentHeight}px)
      div.virtual-list-items   (position: absolute; transform: translateY({transformY}px))
        div[data-original-index=N]   (one per visible item)
          <CommitRow />
```

Key properties:
- **Viewport** is the scroll container (`overflow-y: scroll`)
- **Content** div has explicit `height` set to total content height (creates scrollbar)
- **Items** div is `position: absolute` and translated via `translateY` to show the correct window
- Only visible items + buffer exist in the DOM (~40 nodes for any history size)
- Item height: `ROW_HEIGHT = 26px` (fixed, passed as `defaultEstimatedItemHeight`)

### Current Per-Row SVG (LaneSvg.svelte)

Each `CommitRow` renders a `LaneSvg` inside the graph column. The SVG is `width={maxColumns * LANE_WIDTH}` and `height={ROW_HEIGHT}`. It draws:
- Layer 1: Vertical rail lines (straight edges continuing through the row)
- Layer 2: Manhattan-routed merge/fork connection paths
- Layer 3: Commit dot (solid, hollow for merge, dashed for WIP)

Each row's SVG is self-contained. Edges that span row boundaries are drawn as fragments: a line from `y=cy` to `y=rowHeight` in the current row, continuing from `y=0` to `y=cy` in the next row.

### Current Ref Pills and Connectors

Ref pills are HTML `<span>` elements in the ref column (column 1). A horizontal CSS `<div>` connector line stretches from the pill to the commit dot in the graph column. The connector is positioned with `position: absolute` and calculated width: `refContainerWidth + graphColumnOffset + dotCenterX`.

### Graph Constants

```
LANE_WIDTH = 12px
ROW_HEIGHT = 26px
DOT_RADIUS = 6px
EDGE_STROKE = 1px
WIP_STROKE = 1.5px
MERGE_STROKE = 2px
```

---

## Recommended Architecture: Clipped SVG Inside the Graph Column

### The Core Decision: Clipped Column, Not Overlay

**Use a single full-height SVG placed inside the graph column cell of each CommitRow, but backed by a shared SVG data model where each path is computed once across the entire commit list.**

Rationale against a true overlay:
1. **Z-index chaos.** An overlay SVG on top of the virtual list container would sit above ALL row content (text, pills, buttons). Making dots clickable while keeping text selectable requires `pointer-events: none` on the SVG with `pointer-events: auto` on individual dots -- fragile and platform-dependent.
2. **Scroll synchronization.** The virtual list viewport is the scroll container. An overlay outside it would need manual scroll sync via `scrollTop` mirroring. The virtual list's `transformY` is internal state -- tracking it requires reaching into library internals.
3. **Column resizing breaks.** The graph column width is user-adjustable. An overlay would need to track column position and width reactively, duplicating layout logic.

**Instead:** Keep the graph column's DOM slot per row, but change what renders there. Each row's graph cell renders a `<svg>` that is a viewport into a single logical full-height SVG via `viewBox` clipping.

### How It Works

**Pre-compute once, render per-row via viewBox:**

1. When `displayItems` changes (load/refresh), compute all SVG path data for the entire commit list -- one `<path d="...">` string per branch rail, one per merge/fork edge, one per ref connector, plus dot positions.
2. Store these in a reactive `GraphSvgData` object (shared `$state`).
3. Each `CommitRow`'s graph cell renders a `<svg>` with:
   - `width={columnWidths.graph}` (matches column)
   - `height={ROW_HEIGHT}` (matches row)
   - `viewBox="0 {rowIndex * ROW_HEIGHT} {svgWidth} {ROW_HEIGHT}"` (clips to this row's vertical band)
   - Contains ALL path elements (rails, edges, dots, ref connectors, ref pills)

The viewBox clip means only the portion of each path that intersects this row's vertical band is visible. The browser efficiently clips the rest without layout cost.

### Why viewBox Clipping Is Efficient

Each row's SVG contains references to the same path data, but the browser only rasterizes the visible portion defined by the viewBox. SVG path rendering with clip is O(visible-segments), not O(total-path-length). For a 26px-tall viewBox on a path spanning 260,000px, the browser clips early in the rendering pipeline.

With ~40 visible rows * ~20 paths average = ~800 SVG path elements in the DOM at any time. This is well within browser SVG performance limits (browsers handle thousands of path elements without issue).

### Alternative Considered: Single Overlay SVG

Place one `<svg>` element as a sibling to the virtual list viewport, positioned absolutely over the graph column area, with its own scroll tracking.

**Why rejected:**
- Requires reading `transformY` from the virtual list (not exposed in the public API)
- Requires duplicating scroll event handling
- Z-index management with interactive elements (dots, pills) is fragile
- Column resize tracking requires DOM measurement on each resize frame
- Breaks the established "each row is self-contained" pattern of the virtual list

---

## Component Architecture

### New Component: `GraphSvg.svelte`

Replaces `LaneSvg.svelte`. Renders a single `<svg>` element per row that shows a viewBox-clipped slice of the full graph.

```svelte
<script lang="ts">
  interface Props {
    rowIndex: number;
    graphData: GraphSvgData;
    svgWidth: number;
    maxColumns: number;
  }
</script>

<svg
  width={svgWidth}
  height={ROW_HEIGHT}
  viewBox="0 {rowIndex * ROW_HEIGHT} {svgWidth} {ROW_HEIGHT}"
>
  <!-- Layer 1: Rail paths (one <path> per active lane) -->
  {#each graphData.rails as rail}
    <path d={rail.d} stroke={rail.color} stroke-width={EDGE_STROKE} fill="none" />
  {/each}

  <!-- Layer 2: Connection paths (one <path> per merge/fork edge) -->
  {#each graphData.connections as conn}
    <path d={conn.d} stroke={conn.color} stroke-width={EDGE_STROKE} fill="none"
          stroke-linecap="round" />
  {/each}

  <!-- Layer 3: Dots (one <circle> per commit) -->
  {#each graphData.dots as dot}
    <circle cx={dot.cx} cy={dot.cy} r={dot.r} fill={dot.fill}
            stroke={dot.stroke} stroke-width={dot.strokeWidth} />
  {/each}

  <!-- Layer 4: Ref connectors (one <line> per ref pill) -->
  {#each graphData.refConnectors as conn}
    <line x1={conn.x1} y1={conn.y1} x2={conn.x2} y2={conn.y2}
          stroke={conn.color} stroke-width={EDGE_STROKE} />
  {/each}

  <!-- Layer 5: Ref pills (one <g> per ref) -->
  {#each graphData.refPills as pill}
    <g transform="translate({pill.x}, {pill.y})">
      <rect rx="8" ry="8" width={pill.width} height={pill.height}
            fill={pill.bgColor} />
      <text x={pill.textX} y={pill.textY} fill="white"
            font-size="11" font-weight={pill.isBold ? 'bold' : 'normal'}>
        {pill.label}
      </text>
    </g>
  {/each}
</svg>
```

**Key insight:** Every row renders the SAME set of paths/dots/pills. The `viewBox` clips to only show the row's vertical slice. The browser skips rendering elements entirely outside the viewBox.

### New Module: `graph-svg-data.svelte.ts`

A reactive `$state` module that computes all SVG geometry from the commit list. This is the core new logic.

```typescript
// graph-svg-data.svelte.ts

export interface RailPath {
  d: string;        // SVG path data for the full vertical rail
  color: string;    // CSS variable reference
}

export interface ConnectionPath {
  d: string;        // SVG path data for the merge/fork edge
  color: string;
}

export interface DotData {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  oid: string;       // For click handling
  rowIndex: number;   // For hit testing
}

export interface RefConnector {
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
}

export interface RefPillData {
  x: number; y: number;
  width: number; height: number;
  bgColor: string;
  label: string;
  textX: number; textY: number;
  isBold: boolean;
  rowIndex: number;
}

export interface GraphSvgData {
  rails: RailPath[];
  connections: ConnectionPath[];
  dots: DotData[];
  refConnectors: RefConnector[];
  refPills: RefPillData[];
}
```

### Path Computation: Rails

A rail is a continuous vertical line for a lane. Currently, each row draws straight edges independently. The new approach:

1. Walk through all commits in order.
2. For each lane column, track contiguous vertical segments where a straight edge exists.
3. Merge contiguous segments into a single SVG `M x y1 V y2` path.

```
For commits [0..N], lane column C:
  Start at commit i where edges include Straight with from_column=C
  Continue while consecutive commits also have Straight edge in column C
  Emit: M {cx(C)} {i * ROW_HEIGHT} V {(j+1) * ROW_HEIGHT}
  where j is the last commit in the contiguous segment
```

Branch tips: a rail starts at `cy` of the branch tip row (not `y=0`), matching current behavior where `is_branch_tip && edge.from_column === commit.column` starts the line at `cy` instead of `0`.

### Path Computation: Merge/Fork Edges

Each merge/fork edge spans exactly one row in the current model (the edge data is on the commit that has the merge or fork). The path geometry stays the same as `buildEdgePath` in `LaneSvg.svelte`, just with `cy` computed from `rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2`.

These are already single-row paths, so the "continuous path" benefit is less relevant here. However, moving them into the shared data model ensures consistent z-ordering and enables future multi-row edge routing if needed.

### Path Computation: WIP Connector

The WIP row (index 0 when `wipCount > 0`) draws a dashed line from the WIP dot to the HEAD dot in the next row. In the full-height model, this becomes a single dashed path: `M {cx(0)} {wipDotCy + DOT_RADIUS} V {headDotCy}`.

### Ref Pills as SVG Elements

Currently ref pills are HTML `<span>` elements in the ref column with an absolute-positioned `<div>` connector line. The rework moves both into the SVG:

1. **Connector:** An SVG `<line>` from the pill's right edge to the commit dot center.
2. **Pill:** An SVG `<g>` containing a `<rect>` (rounded corners) and `<text>`.

**Positioning:** Ref pills sit to the LEFT of the graph, extending into negative x-coordinates. The SVG viewBox starts before x=0 to include the ref column space. The viewBox becomes: `viewBox="{-refColumnWidth} {rowIndex * ROW_HEIGHT} {refColumnWidth + graphColumnWidth} {ROW_HEIGHT}"`.

**Text measurement:** SVG `<text>` width is not known until rendered. For pill sizing, pre-compute approximate widths using a character-width heuristic (monospace: ~6.6px per char at 11px font-size, proportional: ~5.5px). Alternatively, use a hidden `<canvas>` context's `measureText()` for accurate pre-computation.

**Interaction:** Ref pills in SVG support `onclick`, `onmouseenter`, `onmouseleave` natively. The "+N" overflow badge and expanded overlay from `CommitRow.svelte` can be replicated with SVG groups and CSS transitions on `opacity`/`clip-path`.

### Dot Interaction (Click / Right-Click)

Dots need to support:
- Left click: select commit (`oncommitselect`)
- Right click: context menu (`showCommitContextMenu`)
- Stash row right click: stash-specific menu

**In the viewBox-clipped model**, each dot is a `<circle>` in the SVG. SVG elements support `onclick` and `oncontextmenu` natively. Since only ~40 rows are in the DOM at once, only ~40 dots exist at any time.

The click handler on the dot receives the `oid` from the dot data:

```svelte
<circle
  cx={dot.cx} cy={dot.cy} r={dot.r}
  fill={dot.fill}
  style="cursor: pointer;"
  onclick={() => oncommitselect?.(dot.oid)}
  oncontextmenu={(e) => showCommitContextMenu(e, dot.oid)}
/>
```

**Row-level click vs dot click:** Currently the entire row is clickable. With the SVG rework, the non-graph columns (message, author, date, SHA) remain HTML divs and keep their row-level click. The graph column SVG handles its own clicks on dots. This is a natural separation.

---

## Data Flow Changes

### Current Flow

```
Rust (walk_commits) → GraphResponse { commits, max_columns }
                           ↓
CommitGraph.svelte:  displayItems = [wip?, ...commits]
                           ↓
VirtualList:  for each visible item → CommitRow
                                        ↓
                                    LaneSvg (per-row SVG path computation)
```

### New Flow

```
Rust (walk_commits) → GraphResponse { commits, max_columns }
                           ↓
CommitGraph.svelte:  displayItems = [wip?, ...commits]
                           ↓
                     graphSvgData = computeGraphSvg(displayItems, maxColumns)
                           ↓                        ↑
                           ↓                  (recomputed on displayItems change)
VirtualList:  for each visible item → CommitRow
                                        ↓
                                    GraphSvg (viewBox-clipped, reads graphSvgData)
```

The key change: path computation moves from per-row (inside `LaneSvg`) to per-dataset (in `computeGraphSvg`). The per-row component becomes a thin viewBox renderer.

### Computation Cost

`computeGraphSvg` runs on every `displayItems` change (initial load, load-more, refresh). With ~200 commits per batch and ~10 lanes:
- Rail path computation: O(commits * lanes) = ~2000 iterations
- Edge path computation: O(commits * avg_edges) = ~400 iterations
- Dot computation: O(commits) = ~200 iterations
- Total: <1ms on modern hardware

For repos with 10k+ commits (after multiple load-more batches), the computation grows linearly. At 10k commits with 20 lanes: ~200k iterations. Still <10ms. If it becomes a bottleneck, incremental computation (only recompute new batch paths, append to existing) is straightforward.

### Rust Backend: No Changes Required

The Rust `walk_commits` function and `GraphResult` type remain unchanged. The per-commit edge data (`edges: Vec<GraphEdge>`) already contains all the information needed to compute continuous paths on the frontend. No new IPC commands or type changes needed.

---

## Integration Points

### Modified Components

| File | Change | Why |
|------|--------|-----|
| `CommitRow.svelte` | Replace `LaneSvg` usage with `GraphSvg`; remove ref column connector div; remove `RefPill` usage in ref column cell | Graph+ref rendering moves into SVG |
| `CommitGraph.svelte` | Add `computeGraphSvg` call on `displayItems` change; pass `graphSvgData` to `CommitRow`; remove ref column from the column layout | Data computation moves here |
| `graph-constants.ts` | Possibly add new constants (ref pill sizing) | SVG pill dimensions |

### New Files

| File | Purpose |
|------|---------|
| `src/components/GraphSvg.svelte` | ViewBox-clipped SVG renderer (replaces `LaneSvg.svelte`) |
| `src/lib/graph-svg-data.svelte.ts` | Reactive computation of full-height SVG paths from commit data |

### Removed Files

| File | Why |
|------|-----|
| `src/components/LaneSvg.svelte` | Replaced by `GraphSvg.svelte` |
| `src/components/RefPill.svelte` | Ref pills become SVG elements inside `GraphSvg` |

### Unchanged

| File | Why Unchanged |
|------|---------------|
| `src-tauri/src/git/graph.rs` | Lane algorithm output is sufficient |
| `src-tauri/src/git/types.rs` | No new Rust types needed |
| `src/lib/types.ts` | No new TypeScript types needed (frontend-only data model) |
| `src/lib/invoke.ts` | No new IPC commands |
| `src/components/App.svelte` | No changes to app shell |

---

## Column Layout Impact

### Current 6-Column Layout

```
| Ref (120px) | Graph (120px) | Message (flex-1) | Author | Date | SHA |
```

The ref column and graph column are separate. The connector div bridges them.

### New Layout: Merge Ref + Graph Into One SVG Column

The ref pills and connectors move into the SVG. Two options:

**Option A: Keep separate columns, SVG spans both.**
The SVG viewBox extends leftward to cover the ref column area. The ref column cell renders nothing (empty); the graph column cell renders the SVG which visually extends into the ref area via `overflow: visible` or negative `viewBox` x-origin.

**Problem:** The ref column still takes up layout space and has a resize handle. The SVG content in the graph column bleeds into the ref column visually but they are separate DOM elements. Column resizing either of them independently creates visual mismatches.

**Option B (recommended): Merge ref+graph into a single "graph" column.**
Remove the separate ref column. The graph column becomes wider and contains both the graph lines and the ref pills. The SVG viewBox covers the full width. The column width is `refWidth + graphWidth` combined, or just one adjustable width.

**Why B is better:**
- Single source of truth for the column width
- No cross-column overflow tricks
- Ref pills are positioned relative to dots in the same coordinate space
- One resize handle controls the entire graph+ref area
- Simpler DOM structure

**Impact on column resize logic:** The `columnWidths` type drops the `ref` key. The `graph` key represents the combined column. The minimum width becomes `max(maxColumns * LANE_WIDTH + refPillMaxWidth, 120)`.

**Impact on header:** The "Branch/Tag" and "Graph" header labels merge into one "Graph" label. The column visibility toggle for ref becomes part of the graph column toggle.

---

## Ref Pill Sizing Without DOM Measurement

SVG text requires knowing width before rendering the background `<rect>`. Two approaches:

**Approach 1 (recommended): Canvas measureText pre-computation.**

```typescript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d')!;
ctx.font = '600 11px system-ui, sans-serif';

function measurePillWidth(label: string): number {
  return ctx.measureText(label).width + 12; // 12px horizontal padding
}
```

Call once per ref label during `computeGraphSvg`. The canvas is never inserted into the DOM. `measureText` is synchronous and fast (~0.01ms per call).

**Approach 2: Character-width heuristic.**

```typescript
const AVG_CHAR_WIDTH = 6.2; // for 11px system font, semibold
function estimatePillWidth(label: string): number {
  return label.length * AVG_CHAR_WIDTH + 12;
}
```

Less accurate but zero DOM dependency. Good enough for most cases.

**Recommendation:** Use canvas `measureText`. It is exact, fast, and avoids layout shifts from mismatched pill/text widths.

---

## Interaction Model

### Row Click (Commit Select)

Currently: the entire `CommitRow` div has `onclick`. This remains unchanged for the non-graph columns. The graph column SVG does NOT need its own click handler for commit selection -- the row-level handler covers it.

Exception: if the graph column SVG has `pointer-events: none` on the root SVG, clicks pass through to the row div. But dots need to be interactive. Solution: the SVG root has `pointer-events: none`, individual dots have `pointer-events: auto`.

```svelte
<svg ... style="pointer-events: none;">
  <!-- Paths: not interactive -->
  <path ... />

  <!-- Dots: interactive -->
  <circle ... style="pointer-events: auto; cursor: pointer;"
    onclick={(e) => { e.stopPropagation(); oncommitselect?.(dot.oid); }}
  />
</svg>
```

### Right-Click Context Menu

Currently handled at row level in `CommitRow.svelte` via `oncontextmenu`. The graph column SVG dots can have their own `oncontextmenu` handler, but since the row-level handler already provides the commit context menu, the simplest approach is to let right-clicks on dots bubble up to the row handler.

For stash rows (oid starts with `__stash_`), the row handler already checks the oid pattern. No SVG-specific changes needed.

### Ref Pill Hover Expansion

Currently: hovering the "+N" badge in the ref column reveals an expanded overlay with all ref names. This uses CSS `clip-path` animation.

In SVG: the same effect is achieved by toggling visibility of an expanded `<g>` group on `mouseenter`/`mouseleave`. The expanded group renders additional pill rects and text below/above the "+N" badge.

**Potential issue:** SVG elements are clipped by the viewBox. An expanded pill list that extends beyond `ROW_HEIGHT` would be clipped. Solution: the expanded overlay should be an HTML `<div>` positioned absolutely relative to the row, triggered by SVG mouse events. This matches the current pattern (the overlay is already HTML, not SVG).

---

## Patterns to Follow

### Pattern 1: Centralized Path Computation with Reactive Derivation

**What:** Compute all SVG path data in a single `$derived.by()` block inside `CommitGraph.svelte`, triggered by `displayItems` changes.

**Why:** Ensures all paths are consistent. Avoids per-row path computation. Makes it easy to implement features that span rows (continuous rails, multi-row edge animations).

```typescript
const graphSvgData = $derived.by(() => {
  return computeGraphSvg(displayItems, maxColumns, columnWidths.graph);
});
```

### Pattern 2: ViewBox Clipping for Virtual Scroll Compatibility

**What:** Each visible row renders the full SVG data set but clips to its vertical band via `viewBox="0 {rowIndex * ROW_HEIGHT} {width} {ROW_HEIGHT}"`.

**Why:** The virtual list controls which rows exist in the DOM. By using viewBox clipping, each row is self-contained (no external scroll sync needed). The browser efficiently clips invisible geometry.

### Pattern 3: SVG Pointer Events Layering

**What:** Set `pointer-events: none` on the SVG root and `pointer-events: auto` on interactive elements (dots, pills). This lets row-level clicks pass through the SVG while keeping specific elements interactive.

**Why:** Avoids blocking row-level click handlers with the SVG overlay. Enables precise hit testing on dots without interfering with message column text selection.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Scroll-Synced Overlay SVG

**What:** Placing a single large SVG element outside the virtual list and syncing its scroll position to match.

**Why bad:** The virtual list's internal `transformY` is not exposed. Mirroring `scrollTop` introduces frame-lag jank. The SVG would need to be the full height of the content (potentially millions of pixels), causing memory and rendering issues.

### Anti-Pattern 2: Per-Row Path Computation in the Render Loop

**What:** Computing path strings inside `GraphSvg.svelte` on every render.

**Why bad:** During fast scrolling, the virtual list creates and destroys rows rapidly. Path computation in the render loop means recomputing the same paths for the same data every time a row enters the viewport.

**Instead:** Pre-compute all paths once when `displayItems` changes. Each row just reads from the pre-computed data.

### Anti-Pattern 3: SVG foreignObject for Ref Pills

**What:** Using `<foreignObject>` to embed HTML ref pills inside the SVG.

**Why bad:** `foreignObject` has inconsistent rendering across WebView engines (especially on Windows with WebView2). Text rendering, overflow, and interaction differ from native SVG text. It also defeats the purpose of moving to SVG.

**Instead:** Use native SVG `<rect>` + `<text>` for pills.

### Anti-Pattern 4: One Giant SVG Element Spanning Full Content Height

**What:** Creating a single SVG with `height={totalCommits * ROW_HEIGHT}` and placing it in the virtual list content area.

**Why bad:** For 10k commits at 26px each, this is a 260,000px tall SVG. Browsers allocate raster buffers proportional to element dimensions. This causes excessive memory usage and potential rendering failures (browsers cap surface sizes).

**Instead:** Each row has its own small SVG (26px tall) with viewBox clipping.

---

## Build Order

### Phase 1: GraphSvgData Computation Engine

1. Create `src/lib/graph-svg-data.svelte.ts` with the `GraphSvgData` interface and `computeGraphSvg()` function
2. Implement rail path computation (continuous vertical lines per lane)
3. Implement connection path computation (merge/fork edges, same geometry as current `buildEdgePath`)
4. Implement dot data computation (position, style based on commit type)
5. Unit test: given a set of `GraphCommit[]`, verify correct path strings

**Rationale:** Pure data transformation with no DOM dependencies. Testable in isolation. All subsequent work depends on this.

### Phase 2: GraphSvg Component (Graph Lines + Dots Only)

1. Create `src/components/GraphSvg.svelte` that renders rails, connections, and dots from `GraphSvgData`
2. Wire into `CommitRow.svelte` replacing `LaneSvg` in the graph column
3. Add `computeGraphSvg` call in `CommitGraph.svelte`
4. Verify: lines are continuous across row boundaries, dots align with text, merge/fork edges render correctly

**Rationale:** Get the core graph rendering working before adding ref pills. Visual regression testing is possible by comparing against current rendering.

### Phase 3: WIP and Stash Row Adaptation

1. Handle WIP sentinel (`__wip__`) in `computeGraphSvg` -- dashed circle, dashed connector to HEAD
2. Handle stash sentinels (`__stash_N__`) -- square dot markers
3. Verify dashed line rendering matches current behavior

**Rationale:** Synthetic rows have special rendering rules. Handle them after the normal commit rendering is solid.

### Phase 4: Ref Pills and Connectors in SVG

1. Add ref pill computation to `computeGraphSvg` using canvas `measureText` for sizing
2. Render pills as SVG `<rect>` + `<text>` in `GraphSvg.svelte`
3. Render connector lines from pill to dot
4. Merge ref column into graph column (remove separate ref column from layout)
5. Update column resize logic (remove `ref` key from `ColumnWidths`)
6. Implement "+N" overflow badge and hover expansion (HTML overlay triggered from SVG events)

**Rationale:** Ref pills are the most visually complex part. Merge columns after pills render correctly. The hover overlay may need iteration.

### Phase 5: Dot Interaction and Context Menus

1. Add `onclick` / `oncontextmenu` handlers to dot circles in `GraphSvg`
2. Verify commit selection works via dot click
3. Verify right-click context menu works on dots
4. Verify stash row context menu works
5. Ensure row-level click still works in non-graph columns

**Rationale:** Interaction handlers are straightforward but need careful testing against the existing behavior.

### Phase 6: Cleanup and Migration

1. Delete `LaneSvg.svelte`
2. Delete `RefPill.svelte`
3. Remove ref column connector div from `CommitRow.svelte`
4. Update `ColumnWidths` and `ColumnVisibility` types (remove `ref` key)
5. Migrate persisted column width store (handle missing `ref` key gracefully)
6. Update column header context menu (remove ref toggle, rename graph label)

**Rationale:** Cleanup after everything works. Store migration must handle users upgrading from v0.3.

---

## Scalability Considerations

| Concern | 200 commits | 2000 commits | 10000+ commits |
|---------|-------------|--------------|-----------------|
| Path computation time | <0.5ms | <2ms | <10ms |
| SVG path data memory | ~10KB | ~100KB | ~500KB |
| DOM nodes (visible) | ~40 rows * ~20 paths = 800 | Same (virtual scroll) | Same (virtual scroll) |
| viewBox clip cost | Negligible | Negligible | Negligible |
| Incremental load-more | Recompute all | Recompute all | Consider incremental append |

At 10k+ commits, if full recomputation on `displayItems` change becomes noticeable, implement incremental path computation: keep existing paths, only compute paths for newly loaded commits, and extend existing rail paths. This is an optimization to defer until profiling shows it is needed.

---

## Sources

- **Existing codebase** -- `CommitGraph.svelte`, `CommitRow.svelte`, `LaneSvg.svelte`, `RefPill.svelte`, `graph-constants.ts`, `types.ts`, `graph.rs`, `types.rs` -- all read directly. Confidence: HIGH.
- **@humanspeak/svelte-virtual-list DOM structure** -- Read from `node_modules/@humanspeak/svelte-virtual-list/dist/SvelteVirtualList.svelte`. Four-layer DOM with `transform: translateY` for item positioning. Confidence: HIGH.
- **SVG viewBox clipping behavior** -- Standard SVG spec. Browser clips geometry outside viewBox without rendering it. Well-established behavior across all modern WebView engines. Confidence: HIGH.
- **Canvas measureText API** -- Standard DOM API. Synchronous, does not require DOM insertion. Used for pre-computing text widths. Confidence: HIGH.
- **SVG pointer-events property** -- Standard SVG/CSS property. `pointer-events: none` on containers with `pointer-events: auto` on children is a well-documented pattern. Confidence: HIGH.

---

*Architecture research for: Trunk v0.4 -- full-height SVG graph rework*
*Researched: 2026-03-12*
