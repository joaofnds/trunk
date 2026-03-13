# Stack Research: Single SVG Overlay Graph Rendering (v0.5)

**Domain:** Git GUI — commit graph visualization
**Researched:** 2026-03-13
**Confidence:** HIGH (all claims grounded in existing codebase inspection, library source code reading, and SVG specification)

## Core Finding: No New Dependencies — Architecture + Algorithm Change Only

The v0.5 milestone requires **zero new npm packages or Rust crates**, same as v0.4. This is a rendering architecture change (per-row SVG → single overlay SVG) combined with a new TypeScript transformation layer and curve math replacement.

**Rationale:** Every capability needed — SVG overlay positioning, cubic bezier path strings, `<rect>`/`<text>` elements, pointer events on SVG — is built into the browser's SVG spec and Svelte's native SVG handling. No library wraps these better than direct use.

---

## Existing Stack (Unchanged)

| Technology | Version | Role in v0.5 | Notes |
|------------|---------|--------------|-------|
| Svelte 5 | ^5.0.0 | Reactive SVG rendering, `$derived.by()` for graph transformation | SVG elements work natively in Svelte templates |
| @humanspeak/svelte-virtual-list | ^0.4.2 | Still drives commit row rendering + scroll | Overlay syncs with its scroll via DOM access |
| TypeScript | ~5.6.2 | Active Lanes transformation, bezier path generation, SVG data types | `strict: true` already enabled |
| Tailwind CSS v4 | ^4.2.1 | Layout utilities, no SVG styling changes | No version change needed |
| Rust (git2 0.19) | — | Lane algorithm unchanged | Already returns `GraphCommit[]` with column/edges |
| vitest | ^4.1.0 | Unit tests for Active Lanes + bezier path functions | Established pattern in `graph-svg-data.test.ts` |

---

## New Capabilities: How Each Is Achieved

### 1. Single SVG Overlay Spanning Virtual List

**What:** One `<svg>` element positioned absolutely over the graph column, full height of the virtualized content, scrolling in sync with the virtual list.

**How (no library needed):**
- The virtual list's DOM structure (verified in source) is:
  ```
  div#virtual-list-container  (position: relative; overflow: hidden)
    div#virtual-list-viewport  (overflow-y: scroll)
      div#virtual-list-content (height: {totalContentHeight}px)
        div#virtual-list-items (transform: translateY)
  ```
- The SVG overlay is placed **inside** `#virtual-list-viewport` (via a Svelte wrapper that renders a sibling to the content div, or as an absolutely-positioned element inside the graph column).
- SVG height = `totalCommits * ROW_HEIGHT` (same as content height).
- Because SVG is inside the viewport's scroll container, it scrolls natively — no JS scroll sync needed.
- `pointer-events: none` on the SVG root, `pointer-events: auto` on interactive elements (dots, ref pills).
- viewBox is set to the full graph dimensions: `viewBox="0 0 {graphWidth} {totalHeight}"`.

**Integration with virtual list:**
- The SVG overlay does NOT use the virtual list's `renderItem` snippet — it's a separate Svelte component rendered as a sibling.
- Access to the viewport element: `document.querySelector('#virtual-list-viewport')` or bind to wrapper div. The `debugFunction` callback provides `startIndex`/`endIndex` for optional SVG element culling, but SVG path elements outside viewport are not rendered by the browser (GPU culling handles this natively for path elements).

**Performance:**
- SVG with 10k `<path>` elements where only ~40 are visible: browsers cull non-visible paths during rasterization. No visible performance impact. This is standard SVG behavior — the DOM nodes exist but only visible ones are painted.
- If profiling shows DOM node count matters (unlikely with `<path>`), visible-range culling using `startIndex`/`endIndex` from `debugFunction` is ~10 lines of filter logic.

[Confidence: HIGH — verified virtual list DOM structure, standard SVG viewport culling behavior]

### 2. TypeScript Active Lanes Transformation

**What:** A pure TypeScript function that transforms Rust `GraphCommit[]` (with per-row edges) into global `GraphData` (continuous edges spanning multiple rows).

**Stack needed:** Only TypeScript. No libraries.

**Type design (new types in `types.ts` or `graph-overlay-types.ts`):**

```typescript
// Input: comes from Rust backend (existing type)
// GraphCommit[] with per-row edges

// Output: global graph data for SVG overlay
interface GraphNode {
  oid: string;
  x: number;       // grid column (swimlane index)
  y: number;       // row index
  colorIndex: number;
  isMerge: boolean;
  isStash: boolean;
  isBranchTip: boolean;
  isWip: boolean;
  refs: RefLabel[];
}

interface GraphEdge {
  parentOid: string;
  childOid: string;
  colorIndex: number;
  dashed: boolean;
  path: string;     // SVG path d-string (cubic bezier)
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  maxColumns: number;
  totalRows: number;
}
```

**Algorithm:** The "Active Lanes" algorithm iterates once through commits (O(n)), tracking which lanes are active at each row. For each commit, it emits a `GraphNode` and connects parent↔child with `GraphEdge`s. The edge path string is computed during this pass using the bezier curve function.

**Testing:** Pure functions — tested with vitest exactly like existing `graph-svg-data.test.ts`. No DOM needed.

[Confidence: HIGH — straightforward data transformation, established testing pattern]

### 3. Cubic Bezier Curve Path Generation

**What:** Replace Manhattan routing (`H`→`A`→`V` paths) with cubic bezier curves (`C` command) for GitKraken-style waterfall edges.

**Stack needed:** SVG `<path>` `C` command. No libraries.

**Math:** A cubic bezier `C` command takes two control points and an endpoint:
```
M x1 y1 C cx1 cy1, cx2 cy2, x2 y2
```

For a merge/fork edge connecting `(x1, y1)` to `(x2, y2)`:
```typescript
function bezierEdgePath(
  x1: number, y1: number,  // child commit position
  x2: number, y2: number,  // parent commit position
): string {
  // Control points: vertical tangent at both ends (waterfall curve)
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}
```

This creates the smooth S-curve that GitKraken uses: the line leaves the child vertically, curves toward the parent lane, and arrives at the parent vertically. The control points ensure tangent continuity at endpoints.

**For straight edges (same column):** Still `M x y1 V y2` — no bezier needed for vertical lines.

**Key constants (adjusted from v0.2-v0.3):**

| Constant | Current | Proposed | Why |
|----------|---------|----------|-----|
| `ROW_HEIGHT` | 26px | 36px | Taller rows give bezier curves room to breathe; matches GitKraken proportions |
| `LANE_WIDTH` | 12px | 16px | Wider lanes prevent curve overlapping at high column counts |
| `DOT_RADIUS` | 6px | 4px | Slightly smaller dots with wider lanes maintain visual balance |

[Confidence: HIGH — SVG cubic bezier is a W3C spec primitive, no library needed]

### 4. SVG Ref Pills (rect + text)

**What:** Migrate ref pills from HTML `<span>` elements in CommitRow to SVG `<rect>` + `<text>` elements inside the overlay SVG.

**Stack needed:** SVG `<rect>`, `<text>`, `<g>` elements. Canvas `measureText()` API for text width measurement. No libraries.

**Text measurement (established in v0.4 research):**
```typescript
const offscreenCanvas = document.createElement('canvas');
const ctx = offscreenCanvas.getContext('2d')!;
ctx.font = '600 11px system-ui, -apple-system, sans-serif';

function measurePillText(label: string): number {
  return ctx.measureText(label).width;
}
```

**SVG pill structure:**
```svelte
<g transform="translate({pillX}, {pillY})" class="ref-pill" onclick={handleRefClick}>
  <rect rx="8" ry="8" width={pillWidth} height={pillHeight}
    fill="var(--lane-{colorIndex % 8})" />
  <text x={paddingX} y={textBaseline} fill="white"
    font-size="11" font-weight="600" font-family="system-ui">
    {label}
  </text>
</g>
```

**Positioning:** Ref pills are placed at `(pillX, nodeY)` where `pillX` is to the left of the graph column (or after the node dot, depending on layout). Connector lines from pill to node dot are simple `<line>` elements.

**Overflow behavior:** When multiple refs exist on one commit, stack vertically or show "+N" badge — same UX as current HTML RefPill, but in SVG.

[Confidence: HIGH — standard SVG primitives, Canvas measureText is synchronous and well-supported]

### 5. Click/Context Menu Interaction on SVG Overlay

**What:** Preserve click-to-select and right-click context menu on graph elements (dots, ref pills).

**Stack needed:** SVG pointer events (native browser behavior). Tauri Menu API (already in use). No libraries.

**How it works:**
- SVG root: `pointer-events="none"` — clicks pass through to CommitRow divs beneath.
- Interactive SVG elements (dots, ref pills): `pointer-events="auto"` — these capture clicks.
- Right-click: use existing `showCommitContextMenu` from CommitGraph.svelte, invoked from SVG element's `oncontextmenu` handler.
- Click: invoke `oncommitselect` callback same as today.

**SVG event binding in Svelte:**
```svelte
<circle cx={node.cx} cy={node.cy} r={DOT_RADIUS}
  fill={laneColor(node.colorIndex)}
  pointer-events="auto"
  onclick={() => oncommitselect?.(node.oid)}
  oncontextmenu={(e) => showCommitContextMenu(e, node)}
  style="cursor: pointer;"
/>
```

SVG elements receive the same DOM events as HTML elements — `onclick`, `oncontextmenu`, `onmouseenter`, etc. Svelte handles SVG event binding identically to HTML.

**Hit area:** For thin elements (lines), use invisible wider `<path>` elements with `stroke-width="12"` and `opacity="0"` behind the visible path to expand the clickable area, if needed.

[Confidence: HIGH — SVG pointer events are a fundamental browser capability, Tauri Menu API already used]

---

## Virtual List Integration Strategy

### Scroll Synchronization: Not Needed

The key insight: the SVG overlay lives **inside** the virtual list's scroll viewport. It scrolls natively. No JavaScript scroll sync code is required.

**Implementation:**
1. Wrap the virtual list with a `position: relative` container.
2. Inside the container, place the SVG overlay as `position: absolute; top: 0; left: 0; pointer-events: none;`.
3. The SVG's height matches the virtual list's content height.
4. The SVG is clipped by the viewport's `overflow: hidden` — only visible portions are painted.

**Alternative approach (if wrapper is complex):**
Use `debugFunction` callback to get `startIndex` + `endIndex`, then set SVG `viewBox` to clip to visible range. This avoids needing to position the SVG inside the viewport DOM.

### Accessing Virtual List Internals

| Need | Approach | Risk |
|------|----------|------|
| Total content height | `displayItems.length * ROW_HEIGHT` (fixed row height) | None — we set height |
| Scroll position | Not needed if SVG is inside viewport | — |
| Visible range | `debugFunction` callback → `startIndex`, `endIndex` | None — stable API |
| Scroll container DOM | `querySelector('#virtual-list-viewport')` | Low — ID is stable in library |

[Confidence: HIGH — verified library DOM structure and API surface]

---

## Rust Backend: No Changes Required

Same conclusion as v0.4 research. The lane algorithm returns all data needed:

| Rust Data | Frontend Use |
|-----------|-------------|
| `GraphCommit.column` | `GraphNode.x` (swimlane index) |
| `GraphCommit.color_index` | `GraphNode.colorIndex` |
| `GraphCommit.edges[]` | Source for `GraphEdge` construction |
| `GraphCommit.is_branch_tip` | Where branch lines start |
| `GraphCommit.is_merge` | Hollow dot styling |
| `GraphCommit.is_stash` | Dashed line styling |
| `GraphCommit.refs[]` | SVG ref pill data |
| `GraphResult.max_columns` | SVG width calculation |

The TypeScript Active Lanes transformation consumes this data and produces the overlay graph. No new IPC commands, no Rust type changes.

[Confidence: HIGH — direct comparison of Rust types.rs with required GraphNode/GraphEdge fields]

---

## File Impact Summary

| File | Change | Description |
|------|--------|-------------|
| `graph-overlay.ts` | **New** | Active Lanes transformation: `GraphCommit[]` → `GraphData` |
| `graph-bezier.ts` | **New** | Cubic bezier path generation functions |
| `graph-overlay.test.ts` | **New** | Unit tests for Active Lanes algorithm |
| `graph-bezier.test.ts` | **New** | Unit tests for bezier path functions |
| `GraphOverlay.svelte` | **New** | Single SVG overlay component (replaces GraphCell + LaneSvg) |
| `SvgRefPill.svelte` | **New** | SVG ref pill component (`<g>` with `<rect>` + `<text>`) |
| `graph-constants.ts` | Modify | Updated ROW_HEIGHT, LANE_WIDTH, DOT_RADIUS |
| `types.ts` | Modify | Add `GraphNode`, `GraphEdge`, `GraphData` interfaces |
| `CommitGraph.svelte` | Major refactor | Integrate overlay, remove GraphCell context, add SVG event handlers |
| `CommitRow.svelte` | Simplify | Remove GraphCell, remove ref pill connector line, remove ref pill HTML |
| `GraphCell.svelte` | **Delete** | Replaced by GraphOverlay |
| `LaneSvg.svelte` | **Delete** | Already superseded by GraphCell; now fully replaced |
| `RefPill.svelte` | **Delete** | Replaced by SvgRefPill |
| `graph-svg-data.ts` | **Delete** | Replaced by graph-overlay.ts |
| `graph-svg-data.test.ts` | **Delete** | Replaced by graph-overlay.test.ts |

---

## What NOT to Add

| Temptation | Why Not | What to Do Instead |
|------------|---------|-------------------|
| D3.js | 108KB min+gz. The geometry is lines + bezier curves + rectangles. D3's force layouts, scales, axes are unused. | Plain TypeScript path string functions |
| SVG.js / Snap.svg | DOM manipulation libraries that conflict with Svelte's reactive rendering. Svelte IS the SVG DOM library here. | Svelte template `<path>`, `<circle>`, `<rect>`, `<text>` |
| Canvas rendering | Loses CSS custom properties (`var(--lane-N)`), loses native pointer events, requires imperative draw calls instead of declarative Svelte templates. | SVG with pointer-events |
| Dagre / ELK / graph layout library | We already HAVE a graph layout (Rust lane algorithm). These solve a different problem (generic DAG layout). | Use existing column/row data |
| `@floating-ui` / Popper.js | For ref pill overflow popover. SVG `<g>` transforms + Svelte `{#if}` handle this without a positioning library. | Manual SVG positioning |
| Web Workers for transformation | Active Lanes is O(n) — sub-millisecond for 10k commits. The expensive work (lane algorithm) already runs in Rust. | Main thread `$derived.by()` |
| `requestAnimationFrame` scroll sync | SVG lives inside the scroll container. It scrolls natively. No sync needed. | Position SVG inside viewport |
| Path smoothing / interpolation libraries | Cubic bezier `C` command is a single SVG primitive. No library can improve on `M x1 y1 C cx1 cy1, cx2 cy2, x2 y2`. | Direct `C` path command |
| Fork @humanspeak/svelte-virtual-list | To expose scroll events. Not needed — SVG inside viewport scrolls natively; `debugFunction` provides visible range. | Use existing API + DOM access |
| Any animation library | Graph transitions are not in scope. Static path rendering with Svelte's native transitions if ever needed. | Defer to v0.6+ if desired |

---

## Alternatives Considered

| Category | Recommended | Alternative | When to Use Alternative |
|----------|-------------|-------------|-------------------------|
| Rendering | Single SVG overlay | Per-row SVG with viewBox (v0.2-v0.3 approach) | Never — overlay enables continuous paths, eliminates seam artifacts |
| Curve type | Cubic bezier (`C`) | Quadratic bezier (`Q`) | If edges always have exactly one bend; cubic is more flexible for S-curves |
| Curve type | Cubic bezier (`C`) | Manhattan routing (`H`+`A`+`V`) | If you want angular look (current v0.3). Bezier is strictly better for this use case. |
| Text measurement | Canvas `measureText` | Character-width heuristic | If pills don't need pixel-perfect sizing (saves one canvas allocation) |
| SVG culling | Let browser handle (GPU cull) | Manual `{#if}` visible range filter | Only if profiling shows 10k+ `<path>` DOM nodes cause layout performance issues |
| Overlay position | Inside viewport (native scroll) | Outside viewport (JS scroll sync) | Never — inside is simpler and avoids all sync bugs |
| Ref pill rendering | SVG `<rect>` + `<text>` | Keep HTML `<span>` pills in CommitRow | If SVG text rendering quality is unacceptable (unlikely with system font) |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| svelte ^5.0.0 | SVG elements, pointer events, `$derived.by()` | All SVG features work natively |
| @humanspeak/svelte-virtual-list ^0.4.2 | SVG overlay inside viewport | No API changes needed; DOM structure verified |
| typescript ~5.6.2 | New interfaces, strict typing | No version change needed |
| vitest ^4.1.0 | New test files for bezier + overlay | Established pattern works |
| tailwindcss ^4.2.1 | Overlay positioning utilities | No version change needed |

---

## Installation

```bash
# No new packages needed
# The existing stack covers all v0.5 requirements
```

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| No new dependencies | HIGH | Every capability maps to browser primitives (SVG, Canvas measureText, DOM events) |
| SVG overlay approach | HIGH | SVG inside scroll container is standard pattern; verified virtual list DOM structure |
| Cubic bezier curves | HIGH | SVG `C` command is W3C spec; simple control point math |
| Active Lanes algorithm | HIGH | O(n) transformation of existing data; pure function, easily tested |
| SVG ref pills | HIGH | `<rect>` + `<text>` in SVG is basic; Canvas measureText for sizing is synchronous |
| SVG interactions | HIGH | `pointer-events` CSS property + DOM event handlers are standard |
| Virtual list integration | HIGH | Verified DOM structure, debugFunction API, ID-based querySelector |

---

## Sources

### Library Source Code (HIGH confidence)
- `node_modules/@humanspeak/svelte-virtual-list/dist/SvelteVirtualList.svelte` — DOM structure (4-layer: container → viewport → content → items), `debugFunction` callback, no scroll position prop
- `node_modules/@humanspeak/svelte-virtual-list/dist/types.d.ts` — full API surface

### Existing Codebase (HIGH confidence)
- `src/lib/graph-svg-data.ts` — current Manhattan routing path generation (being replaced)
- `src/lib/graph-svg-data.test.ts` — testing pattern for path functions (19 tests)
- `src/lib/graph-constants.ts` — `LANE_WIDTH=12`, `ROW_HEIGHT=26`, `DOT_RADIUS=6`
- `src/lib/types.ts` — `GraphCommit`, `GraphEdge`, `SvgPathData`, `RefLabel` interfaces
- `src/components/GraphCell.svelte` — per-row SVG with viewBox clipping (being replaced)
- `src/components/LaneSvg.svelte` — original per-row SVG (already superseded)
- `src/components/CommitRow.svelte` — HTML ref pill connector line, graph column layout
- `src/components/RefPill.svelte` — HTML `<span>` ref pills (being replaced by SVG)
- `src/components/CommitGraph.svelte` — virtual list integration, context menu, `$derived.by()` usage
- `src-tauri/src/git/types.rs` — Rust types confirming all needed data is serialized
- `tsconfig.json` — `strict: true`, `moduleResolution: bundler`, `target: ESNext`

### SVG Specification (HIGH confidence)
- [MDN SVG path — cubic bezier](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths#curve_commands)
- [MDN pointer-events](https://developer.mozilla.org/en-US/docs/Web/CSS/pointer-events)
- [MDN Canvas measureText](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/measureText)
- [SVG text element](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/text)

---

*Stack research for: Trunk v0.5 — Single SVG overlay graph with cubic bezier curves*
*Researched: 2026-03-13*
