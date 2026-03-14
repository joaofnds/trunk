# Phase 23: SVG Rendering - Research

**Researched:** 2026-03-14
**Domain:** Svelte 5 SVG rendering with virtualization, three-layer z-ordering, commit dot styling
**Confidence:** HIGH

## Summary

Phase 23 is the rendering phase that wires together the data pipeline (Phase 21: `buildGraphData()`) and path generation (Phase 22: `buildOverlayPaths()`) into actual SVG elements inside the overlay `<svg>` established in Phase 20. The core challenge is **SVG virtualization** — rendering only the paths/dots/rails that intersect the visible row range plus a buffer, capped on DOM node count regardless of total commit count.

The existing codebase provides all the building blocks: `OverlayGraphData` (nodes + edges), `OverlayPath[]` (with `d` strings, `colorIndex`, `dashed`, `kind`), overlay constants (`OVERLAY_*`), the `<svg>` overlay snippet in `CommitGraph.svelte`, and the VirtualList that already computes `visibleItems.start/end`. The rendering itself is straightforward Svelte 5 `{#each}` blocks producing SVG `<path>`, `<circle>`, and `<rect>` elements in three `<g>` groups. The virtualization requires filtering paths/nodes by row range, which is a pure computation on existing data.

**Primary recommendation:** Build a pure TypeScript function `getVisibleOverlayElements()` that filters `OverlayPath[]` and `OverlayNode[]` by visible row range (with buffer), then render the filtered results in three `<g>` groups inside the existing overlay `<svg>` snippet. Expose VirtualList's `visibleItems` range to the overlay snippet by extending its signature.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OVRL-04 | SVG renders only visible-range elements plus buffer — hard cap on DOM node count | Virtualization via row-range filtering of OverlayPath[] and OverlayNode[]; VirtualList exposes visible range; buffer extends start/end by configurable amount |
| CURV-03 | SVG uses three-layer `<g>` group z-ordering: rails behind edges behind dots | Three `<g>` groups in SVG: rails (kind='rail'), connections (kind='connection'), dots (from nodes). SVG paints in document order — later groups render on top |
| DOTS-01 | Normal commits render as filled circles, merge commits as hollow circles | OverlayNode.isMerge distinguishes: filled `<circle>` (normal) vs hollow `<circle>` with `fill="var(--color-bg)"` and stroke (merge) |
| DOTS-02 | WIP row renders with hollow dashed circle and dashed connector to HEAD | OverlayNode.isWip flag; hollow circle with `stroke-dasharray="3 3"`; dashed connector already in OverlayPath[] from buildOverlayPaths() |
| DOTS-03 | Stash rows render with filled squares and dashed connectors | OverlayNode.isStash flag; `<rect>` element instead of `<circle>`; dashed connectors already in OverlayPath[] from buildOverlayPaths() |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte 5 | Current | Component framework with `$derived`, snippets | Already in use; `{#each}` blocks for SVG rendering |
| SVG (browser native) | N/A | Scalable vector graphics | Zero-dependency; CSS custom properties work in `stroke`/`fill` |
| Vitest | Current | Unit testing | Already in use for all overlay pipeline tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | — | — | All capabilities are browser SVG primitives + existing Svelte patterns |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Filtering OverlayPath[] | SVG `<clipPath>` per viewport | clipPath hides elements but doesn't reduce DOM node count — fails OVRL-04 |
| Manual row-range filter | Intersection Observer per path | Way too many observers; per-path IO is O(n) setup vs O(1) range filter |

## Architecture Patterns

### Data Flow
```
GraphCommit[]
    ↓ buildGraphData() [Phase 21]
OverlayGraphData { nodes: OverlayNode[], edges: OverlayEdge[], maxColumns }
    ↓ buildOverlayPaths() [Phase 22]
OverlayPath[] { d, colorIndex, dashed, kind: 'rail' | 'connection' }
    ↓ getVisibleOverlayElements() [Phase 23 — NEW]
{ visibleRails: OverlayPath[], visibleConnections: OverlayPath[], visibleDots: OverlayNode[] }
    ↓ SVG rendering [Phase 23 — NEW]
<svg> → <g class="rails"> → <g class="connections"> → <g class="dots">
```

### Key Architectural Decision: Virtualization Strategy

The virtualization challenge is: given all paths and nodes for the full graph, render only the subset visible in the viewport (plus buffer). Two approaches considered:

**Approach: Row-range filtering (RECOMMENDED)**
- `OverlayNode[]` already has `y` (row index) — filter by `startRow <= y <= endRow`
- `OverlayPath[]` (rails): `fromY`/`toY` range intersects visible range — check `toY >= startRow && fromY <= endRow`
- `OverlayPath[]` (connections): row is encoded in the path's source edge — but we DON'T have `fromY`/`toY` on `OverlayPath`. Solution: **add `minRow` and `maxRow` fields** to `OverlayPath` during `buildOverlayPaths()`, OR filter at the `OverlayEdge` level and rebuild paths only for visible edges.

**Simplest correct approach**: Filter at the `OverlayGraphData` level (edges + nodes by row range), then call `buildOverlayPaths()` on the filtered subset. BUT this breaks rail coalescing — a rail spanning rows 0-100 would get clipped to rows 10-30 if those are visible, losing the visual continuity above/below.

**Best approach**: Add `minRow`/`maxRow` metadata to `OverlayPath` during `buildOverlayPaths()` (trivial — already has fromY/toY from the OverlayEdge). Then filter `OverlayPath[]` by row-range intersection. This preserves the full path `d` string (so rails look continuous) but only includes paths that intersect the viewport.

### Recommended Project Structure
```
src/
├── lib/
│   ├── overlay-paths.ts          # [Phase 22] buildOverlayPaths() — add minRow/maxRow to output
│   ├── overlay-visible.ts        # [NEW] getVisibleOverlayElements() — row-range filter
│   ├── overlay-visible.test.ts   # [NEW] Unit tests for visibility filtering
│   ├── active-lanes.ts           # [Phase 21] buildGraphData() — unchanged
│   ├── types.ts                  # OverlayPath gets minRow/maxRow; VisibleOverlayElements type
│   └── graph-constants.ts        # OVERLAY_* constants — unchanged
├── components/
│   ├── CommitGraph.svelte         # Wires pipeline: graphData → paths → visible → SVG snippet
│   └── VirtualList.svelte         # Expose visibleItems range to overlaySnippet
```

### Pattern 1: Three-Layer SVG Z-Ordering (CURV-03)
**What:** SVG renders elements in document order — later elements paint on top
**When to use:** Any time visual layering must be controlled
**Example:**
```svelte
<svg width={graphWidth} height={contentHeight} style="pointer-events: none;">
  <!-- Layer 1: Rails (behind everything) -->
  <g class="overlay-rails">
    {#each visibleRails as path}
      <path d={path.d} fill="none"
        stroke={laneColor(path.colorIndex)}
        stroke-width={OVERLAY_EDGE_STROKE}
        stroke-linecap="butt"
        stroke-dasharray={path.dashed ? '3 3' : 'none'} />
    {/each}
  </g>

  <!-- Layer 2: Connection edges (middle) -->
  <g class="overlay-connections">
    {#each visibleConnections as path}
      <path d={path.d} fill="none"
        stroke={laneColor(path.colorIndex)}
        stroke-width={OVERLAY_EDGE_STROKE}
        stroke-linecap="round"
        stroke-dasharray={path.dashed ? '3 3' : 'none'} />
    {/each}
  </g>

  <!-- Layer 3: Dots (on top) -->
  <g class="overlay-dots">
    {#each visibleDots as node}
      <!-- dot rendering by node type -->
    {/each}
  </g>
</svg>
```

### Pattern 2: VirtualList Overlay Snippet Extension
**What:** The `overlaySnippet` currently receives only `contentHeight`. For virtualization, it also needs visible row range.
**How:**
```typescript
// VirtualList.svelte — extend snippet signature
overlaySnippet?: Snippet<[contentHeight: number, visibleStart: number, visibleEnd: number]>

// Render call:
{@render overlaySnippet(contentHeight, visibleItems.start, visibleItems.end)}
```

This passes the VirtualList's already-computed `visibleItems.start` and `visibleItems.end` to the overlay, enabling the overlay to filter elements by row range. Zero additional computation — the VirtualList already has this data.

### Pattern 3: Commit Dot Rendering by Type
**What:** Different commit types render as different SVG shapes
**Example:**
```svelte
{#each visibleDots as node}
  {#if node.isWip}
    <!-- WIP: hollow dashed circle -->
    <circle cx={cx(node.x)} cy={cy(node.y)} r={OVERLAY_DOT_RADIUS}
      fill="none" stroke={laneColor(node.colorIndex)}
      stroke-width={OVERLAY_EDGE_STROKE} stroke-dasharray="3 3" />
  {:else if node.isStash}
    <!-- Stash: filled square -->
    <rect
      x={cx(node.x) - OVERLAY_DOT_RADIUS}
      y={cy(node.y) - OVERLAY_DOT_RADIUS}
      width={OVERLAY_DOT_RADIUS * 2}
      height={OVERLAY_DOT_RADIUS * 2}
      fill={laneColor(node.colorIndex)} />
  {:else if node.isMerge}
    <!-- Merge: hollow circle -->
    <circle cx={cx(node.x)} cy={cy(node.y)} r={OVERLAY_DOT_RADIUS}
      fill="var(--color-bg)" stroke={laneColor(node.colorIndex)}
      stroke-width={OVERLAY_MERGE_STROKE} />
  {:else}
    <!-- Normal: filled circle -->
    <circle cx={cx(node.x)} cy={cy(node.y)} r={OVERLAY_DOT_RADIUS}
      fill={laneColor(node.colorIndex)} />
  {/if}
{/each}
```

### Anti-Patterns to Avoid
- **Rendering ALL paths/nodes and using CSS `display:none`:** Fails OVRL-04 — DOM nodes still exist even if hidden
- **Using SVG `<clipPath>` for virtualization:** Hides visual output but doesn't reduce DOM count
- **Computing paths inside the Svelte template:** Heavy computation in `{#each}` blocks causes jank — pre-compute everything in `$derived`
- **Separate SVG per layer:** Multiple SVGs would break z-ordering and complicate positioning — use single SVG with `<g>` groups

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Visible range computation | Custom scroll position tracking | VirtualList's `visibleItems.start/end` | Already computed, reactive, handles edge cases |
| SVG path generation | Manual `d` string building | `buildOverlayPaths()` from Phase 22 | Already tested with 34 tests, handles all edge types |
| Graph data transformation | Custom commit-to-node mapping | `buildGraphData()` from Phase 21 | Already tested with 25 tests, handles all commit types |
| Lane color resolution | Color calculation | `var(--lane-${idx % 8})` CSS custom properties | 8-color palette defined in app.css, works in SVG stroke/fill |

## Common Pitfalls

### Pitfall 1: SVG Coordinate System vs Virtual List Transform
**What goes wrong:** The virtual list uses `translateY()` to position items, but the SVG overlay is positioned absolutely at `top:0` inside the content div. SVG coordinates are global (row 0 at y=0, row N at y=N*ROW_HEIGHT).
**Why it happens:** Confusing the virtual list's item positioning (translateY) with the overlay's coordinate system (absolute, full-height).
**How to avoid:** The SVG overlay spans full content height and uses absolute coordinates. Each element is positioned at `cy(node.y)` = `node.y * OVERLAY_ROW_HEIGHT + OVERLAY_ROW_HEIGHT / 2`. No translateY compensation needed — the SVG scrolls natively with the scroll container.
**Warning signs:** Dots appear at wrong vertical positions; paths don't align with commit rows.

### Pitfall 2: Buffer Too Small or Too Large
**What goes wrong:** With no buffer, elements disappear at the edges of the viewport as you scroll. With too large a buffer, too many DOM nodes are created (defeating virtualization).
**Why it happens:** The visible range from VirtualList has a `bufferSize` of 20 (its own buffer for HTML items). The SVG overlay needs its own buffer that extends slightly beyond the viewport.
**How to avoid:** Use the VirtualList's `visibleItems` range directly — it already includes the buffer (bufferSize=20). This is ~20 rows of extra rendering above and below the viewport. For SVG, this is sufficient since paths/dots are lightweight.
**Warning signs:** Elements popping in/out at viewport edges during scrolling.

### Pitfall 3: Rail Path Clipping at Viewport Edges
**What goes wrong:** A vertical rail spanning rows 0-100 is filtered out because neither `fromY` nor `toY` is in the visible range [30, 60], even though the rail passes through the viewport.
**Why it happens:** Naive filter checks only `fromY` and `toY`, not whether the rail intersects the range.
**How to avoid:** Use range intersection: `path.maxRow >= startRow && path.minRow <= endRow`. This catches rails that pass through the viewport even if they start above and end below.
**Warning signs:** Vertical rails disappearing as you scroll through long branch runs.

### Pitfall 4: Stale Reactive Computations
**What goes wrong:** Graph data recomputes on every scroll event because `visibleItems` changes reactively.
**Why it happens:** Putting `buildGraphData()` and `buildOverlayPaths()` inside a `$derived` that depends on `visibleItems`.
**How to avoid:** Separate the computation chain: `graphData` and `overlayPaths` depend only on `displayItems` (the commit list). Only the filtering step (`getVisibleOverlayElements()`) depends on `visibleItems`. This ensures path computation happens only when commits change, not on every scroll.
**Warning signs:** Scroll performance degradation with large repos; profiler shows `buildOverlayPaths()` re-executing on scroll.

### Pitfall 5: Incorrect Dot Ordering in GraphCell Legacy
**What goes wrong:** Both the old `GraphCell.svelte` (per-row SVGs) and the new overlay SVG render dots simultaneously.
**Why it happens:** Phase 23 adds overlay dots but Phase 24 is where old pipeline is removed.
**How to avoid:** During Phase 23, the overlay renders inside the `<svg>` snippet that currently has `<!-- Overlay content will be rendered by future phases (21+) -->`. The old `GraphCell.svelte` is still rendered by `CommitRow.svelte`. Phase 24 removes the old pipeline. For now, both coexist — the overlay SVG has `pointer-events: none` and renders on top of the graph column. This is acceptable as an intermediate state.
**Warning signs:** Double dots appearing; dots in two slightly different positions.

## Code Examples

### Extending OverlayPath with Row Metadata

The `OverlayPath` type needs `minRow`/`maxRow` for efficient virtualization filtering:

```typescript
// types.ts — extend OverlayPath
export interface OverlayPath {
  d: string;
  colorIndex: number;
  dashed: boolean;
  kind: 'rail' | 'connection';
  minRow: number;   // NEW: lowest row this path touches
  maxRow: number;   // NEW: highest row this path touches
}
```

In `overlay-paths.ts`, the `buildRailPath()` already knows `fromY`/`toY` and `buildConnectionPath()` already knows `fromY`. Adding these fields is trivial:

```typescript
// In buildRailPath():
return {
  d: `M ${cx(col)} ${startY} V ${endY}`,
  colorIndex: edge.colorIndex,
  dashed: edge.dashed,
  kind: 'rail',
  minRow: edge.fromY,
  maxRow: edge.toY,
};

// In buildConnectionPath():
return {
  d,
  colorIndex: edge.colorIndex,
  dashed: edge.dashed,
  kind: 'connection',
  minRow: edge.fromY,
  maxRow: edge.fromY,  // connection edges occupy a single row
};
```

### Visibility Filter Function

```typescript
// overlay-visible.ts
import type { OverlayNode, OverlayPath } from './types.js';

export interface VisibleOverlayElements {
  rails: OverlayPath[];
  connections: OverlayPath[];
  dots: OverlayNode[];
}

export function getVisibleOverlayElements(
  paths: OverlayPath[],
  nodes: OverlayNode[],
  startRow: number,
  endRow: number,
): VisibleOverlayElements {
  const rails: OverlayPath[] = [];
  const connections: OverlayPath[] = [];

  for (const path of paths) {
    // Range intersection: path overlaps [startRow, endRow]
    if (path.maxRow >= startRow && path.minRow <= endRow) {
      if (path.kind === 'rail') {
        rails.push(path);
      } else {
        connections.push(path);
      }
    }
  }

  const dots = nodes.filter(n => n.y >= startRow && n.y <= endRow);

  return { rails, connections, dots };
}
```

### Reactive Pipeline in CommitGraph.svelte

```typescript
// CommitGraph.svelte — reactive chain (sketch)
import { buildGraphData } from '../lib/active-lanes.js';
import { buildOverlayPaths } from '../lib/overlay-paths.js';
import { getVisibleOverlayElements } from '../lib/overlay-visible.js';

// These recompute only when displayItems changes (NOT on scroll):
const overlayGraphData = $derived.by(() => buildGraphData(displayItems, maxColumns));
const overlayPaths = $derived.by(() => buildOverlayPaths(overlayGraphData));

// This recomputes on scroll (cheap — just array filtering):
// visibleStart/visibleEnd come from the overlay snippet's extended args
```

### VirtualList Snippet Extension

```svelte
<!-- VirtualList.svelte — extend snippet render call -->
{#if overlaySnippet}
  {@render overlaySnippet(contentHeight, visibleItems.start, visibleItems.end)}
{/if}

<!-- Snippet type becomes: -->
overlaySnippet?: Snippet<[contentHeight: number, visibleStart: number, visibleEnd: number]>
```

### Lane Color Helper (Consistent Pattern)

```typescript
const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
```

Used identically in `GraphCell.svelte`, `LaneSvg.svelte`, and `RefPill.svelte`. Replicate in the overlay rendering context.

## State of the Art

| Old Approach (v0.4) | Current Approach (v0.5) | When Changed | Impact |
|---------------------|-------------------------|--------------|--------|
| Per-row `<svg>` with viewBox clipping | Single overlay `<svg>` spanning full height | Phase 20 (v0.5) | Continuous paths, no seam artifacts |
| `computeGraphSvgData()` → Map<string, SvgPathData> | `buildGraphData()` → `buildOverlayPaths()` → OverlayPath[] | Phases 21-22 (v0.5) | Edge coalescing, cubic bezier corners |
| No virtualization (all paths rendered, clipped by viewBox) | Row-range filtering caps DOM node count | Phase 23 (this phase) | O(viewport) DOM nodes instead of O(total) |
| Edge type classification by key substring | Explicit `kind: 'rail' \| 'connection'` field | Phase 22 (v0.5) | Cleaner z-order layering |

## Open Questions

1. **Phase 23 vs Phase 24 Boundary: When Does Old Pipeline Go Away?**
   - What we know: Phase 24 (Integration) is where old GraphCell/LaneSvg are removed and the overlay becomes the sole renderer
   - What's clear: Phase 23 builds the overlay renderer, Phase 24 wires it in and removes old code
   - Recommendation: Phase 23 should build the rendering logic (component/functions) but NOT yet remove old code. The overlay snippet in CommitGraph.svelte gets populated. During Phase 23, both old per-row SVGs and new overlay coexist. Phase 24 removes the old pipeline.

2. **Overlay Snippet Extension: Add Args or Use Context?**
   - What we know: VirtualList's `overlaySnippet` currently takes only `contentHeight`. We need visible range too.
   - Options: (a) Extend snippet signature to include `visibleStart, visibleEnd`, or (b) expose via Svelte context/bindable prop
   - Recommendation: Extend snippet signature — simplest, most direct, zero-ceremony. The VirtualList already computes `visibleItems` and passes it to `displayItems` — adding it to the snippet call is one line.

3. **Buffer Size for SVG Elements**
   - What we know: VirtualList uses `bufferSize=20` for HTML items. The overlay can reuse this same range.
   - Recommendation: Use VirtualList's `visibleItems` range directly (already includes buffer). If scrolling shows artifacts, add an additional SVG-specific buffer of ~5 rows in `getVisibleOverlayElements()`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (already installed) |
| Config file | `vitest.config.ts` or `vite.config.ts` (existing) |
| Quick run command | `npx vitest run src/lib/overlay-visible.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OVRL-04 | Filtering returns only elements in visible range + buffer | unit | `npx vitest run src/lib/overlay-visible.test.ts -x` | ❌ Wave 0 |
| OVRL-04 | DOM node count capped at visible range (verified by filtering output count) | unit | `npx vitest run src/lib/overlay-visible.test.ts -x` | ❌ Wave 0 |
| CURV-03 | Three-layer z-ordering (rails, connections, dots) | manual | Visual inspection — SVG `<g>` group order in DOM | N/A (structural, not behavioral) |
| DOTS-01 | Normal → filled circle, merge → hollow circle | manual | Visual inspection | N/A (Svelte template logic) |
| DOTS-02 | WIP → hollow dashed circle | manual | Visual inspection | N/A (Svelte template logic) |
| DOTS-03 | Stash → filled square | manual | Visual inspection | N/A (Svelte template logic) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/overlay-visible.test.ts -x`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/overlay-visible.ts` — visibility filtering function
- [ ] `src/lib/overlay-visible.test.ts` — covers OVRL-04 (row-range filtering, edge intersection, buffer handling)
- [ ] `src/lib/types.ts` — `OverlayPath` extended with `minRow`/`maxRow` fields
- [ ] `src/lib/overlay-paths.ts` — updated to populate `minRow`/`maxRow` on output paths
- [ ] `src/lib/overlay-paths.test.ts` — updated tests to verify `minRow`/`maxRow` in output

*(Existing test infrastructure (Vitest, test patterns) is sufficient — no framework install needed)*

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** — `src/lib/types.ts`, `src/lib/overlay-paths.ts`, `src/lib/active-lanes.ts`, `src/components/CommitGraph.svelte`, `src/components/VirtualList.svelte`, `src/components/GraphCell.svelte`
- **Phase 20 summary** — overlay container architecture, SVG placement, pointer-events pattern
- **Phase 21 summary** — `buildGraphData()` API, OverlayNode/OverlayEdge shapes
- **Phase 22 summary** — `buildOverlayPaths()` API, OverlayPath shape with `kind` field
- **Phase 22 CONTEXT.md** — Manhattan routing decisions, rail termination, z-ordering via `kind`

### Secondary (MEDIUM confidence)
- SVG `<g>` group z-ordering follows document order (SVG 2 spec) — well-established browser behavior

### Tertiary (LOW confidence)
- None — all findings based on direct codebase inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries/tools already in use, zero new dependencies
- Architecture: HIGH — builds directly on proven Phase 20-22 patterns and existing VirtualList
- Pitfalls: HIGH — identified from direct codebase analysis of coordinate systems and reactive chains
- Virtualization strategy: HIGH — row-range filtering on existing data structures is straightforward

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable — no external dependencies, all internal code)
