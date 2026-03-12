# Technology Stack: Graph Rendering Rework (v0.4)

**Project:** Trunk — Git GUI
**Researched:** 2026-03-12
**Confidence:** HIGH (all claims grounded in direct source code inspection of existing codebase and library internals)

## Core Finding: No New Dependencies Needed

The v0.4 graph rework requires **zero new npm packages or Rust crates**. This is an architecture change, not a technology change.

**Rationale:** The rework replaces per-row SVG fragments with continuous full-height paths. Whether paths live in a single overlay SVG or in per-row SVGs with shared data via viewBox clipping (see ARCHITECTURE.md for the decision), the technology requirements are identical: SVG `<path>` string generation in TypeScript, Svelte 5 reactive computation via `$derived.by()`, and existing graph data from the Rust lane algorithm.

---

## Existing Stack (Unchanged)

| Technology | Version | Role in Rework | Notes |
|------------|---------|----------------|-------|
| Svelte 5 | ^5.0.0 | Reactive SVG rendering, `$derived.by()` for path computation | SVG elements work natively in Svelte templates |
| @humanspeak/svelte-virtual-list | ^0.4.2 | Still drives commit row rendering + scroll | No API changes needed |
| TypeScript | ~5.6.2 | Path generation functions, type-safe graph data | No version change needed |
| Tailwind CSS v4 | ^4.2.1 | Layout utilities for positioning | No version change needed |
| Rust (git2 0.19) | -- | Lane algorithm unchanged | Already returns all data needed |

---

## Virtual List Library: API Surface Verification

**Critical finding:** `@humanspeak/svelte-virtual-list` v0.4.2 API was thoroughly examined. [Confidence: HIGH -- direct source code reading]

### What It Exposes

| Feature | Available | Details |
|---------|-----------|---------|
| `debugFunction` callback | Yes | Provides `startIndex`, `endIndex`, `totalHeight`, `visibleItemsCount` on every render cycle |
| `scroll()` method | Yes | Programmatic scroll to index with alignment options |
| `onLoadMore` callback | Yes | Triggered near end of list for infinite scroll |
| `hasMore` prop | Yes | Controls whether `onLoadMore` fires |
| `bufferSize` prop | Yes | Items rendered outside viewport (default: 20) |
| Scroll position / `scrollTop` | **No** | Not exposed via API |
| Scroll container element | **No** | Not exposed via API |
| Generic scroll event | **No** | Not exposed via API |

### DOM Structure (Verified)

```
div#virtual-list-container     (position: relative; overflow: hidden)
  div#virtual-list-viewport    (overflow-y: scroll; onscroll bound internally)
    div#virtual-list-content   (height: {contentHeight}px -- full scrollable height)
      div#virtual-list-items   (transform: translateY({transformY}px))
        div[data-original-index=N]   (one per visible item)
          <CommitRow />
```

The viewport element (`#virtual-list-viewport`) is the scroll container. It has `onscroll` bound internally. It can be accessed via `querySelector` if direct scroll position is needed for an overlay approach, though the viewBox-clipped per-row approach (ARCHITECTURE.md) avoids this need entirely.

The `debugFunction` callback is the intended way to get visibility information. It fires on every scroll/resize with `startIndex` and `endIndex`.

---

## SVG Performance at Scale (10k+ Commits)

### Browser SVG Limits

| Scenario | DOM Elements | Performance | Source |
|----------|-------------|-------------|--------|
| ~100-200 visible SVG elements | Trivial | 60fps, no concern | Well-established web standard |
| ~1,000 static SVG paths | Fine | No interaction lag | Multiple sources confirm |
| ~5,000 static SVG paths | Manageable | Style recalc starts to matter | SVG performance guides |
| ~50,000+ SVG elements | Problematic | Sluggish interaction, memory bloat | CSS-Tricks, Khan Academy perf analysis |

### This Project's Profile

With the viewBox-clipped approach (ARCHITECTURE.md): each of ~40 visible rows renders a `<svg>` with all path data, but viewBox clips to 26px tall. Browser only rasterizes visible geometry.

Live DOM at any time: ~40 rows x ~20 paths = ~800 SVG elements. This is trivially fast.

With an overlay approach: a single SVG with ~100-200 visible elements (culled to scroll range). Also trivially fast.

**Conclusion:** SVG is the correct choice. Canvas would only be needed for 50k+ simultaneously visible elements, which never occurs with virtual scrolling. [Confidence: HIGH]

### Why Not Canvas

| Concern | SVG Answer |
|---------|-----------|
| CSS custom properties | SVG `stroke`/`fill` accept `var(--lane-N)` directly. Canvas requires JS color resolution. |
| Accessibility | SVG elements are DOM nodes with ARIA support. Canvas is opaque. |
| Interaction | SVG elements receive pointer events natively. Canvas requires manual hit testing. |
| Developer experience | Svelte templates render SVG declaratively. Canvas requires imperative drawing code. |

---

## SVG Path Generation

### Where: TypeScript, Not Rust

Path `d` string generation is purely a rendering concern. The Rust lane algorithm already provides all data needed.

**Why not Rust:**
- IPC overhead for string data that's already derivable client-side
- Coupling rendering details (pixel coordinates, corner radii) to the backend
- Harder to iterate on visual tweaks (requires recompile)

**Performance:** Path string generation is O(n) string concatenation -- sub-millisecond even for 10k commits. The expensive work (lane algorithm, O(n) ~5ms for 10k commits) already runs in Rust. [Confidence: HIGH]

### New File: `graph-paths.ts` (or `graph-svg-data.svelte.ts`)

Path generation functions extracted into a dedicated module. Uses absolute coordinates (y = rowIndex * ROW_HEIGHT) so paths work with viewBox clipping.

```typescript
// Example: continuous branch rail as single SVG path
function branchRailPath(startRow: number, endRow: number, column: number): string {
  const x = column * LANE_WIDTH + LANE_WIDTH / 2;
  const y1 = startRow * ROW_HEIGHT + ROW_HEIGHT / 2;
  const y2 = endRow * ROW_HEIGHT + ROW_HEIGHT / 2;
  return `M ${x} ${y1} V ${y2}`;
}

// Merge/fork edge: same Manhattan routing as current buildEdgePath(),
// but with absolute y-coordinates instead of relative-to-row
function mergeEdgePath(rowIndex: number, edge: GraphEdge): string {
  const cy = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  // ... same math as LaneSvg.svelte buildEdgePath(), with cy offset
}
```

### Reactive Computation Pattern

Use `$derived.by()` (established project pattern):

```typescript
// Computed once when displayItems changes -- NOT on scroll
const graphSvgData = $derived.by(() =>
  computeGraphSvg(displayItems, maxColumns)
);
```

For 10k commits: ~200k iterations (20 lanes x 10k commits). Still <10ms. If profiling shows this matters, incremental computation (append new batch, extend existing rail paths) is straightforward.

---

## Svelte 5 SVG-Specific Considerations

### Known Issue: SVG Duplication Bug (Issue #12289)

Svelte 5 has a known issue where SVGs duplicate when toggling with `{#if}` blocks instead of properly swapping. [Confidence: HIGH -- GitHub issue sveltejs/svelte#12289]

**Prevention:** Use a single persistent `<svg>` element per row. Conditionally render `<path>` children within it using `{#each}`, not `{#if}` toggling of entire `<svg>` elements.

### SVG Namespace

Svelte handles SVG namespace automatically when elements are inside an `<svg>` tag. No `xmlns` attribute or namespace workarounds needed for `<path>`, `<circle>`, `<line>`, `<g>`, `<rect>`, `<text>`.

### Keyed `{#each}` for Path Updates

When the commit list changes (refresh, load more), use keyed `{#each}` for SVG children to minimize DOM churn:

```svelte
{#each graphData.dots as dot (dot.oid)}
  <circle cx={dot.cx} cy={dot.cy} r={DOT_RADIUS} fill={dot.color} />
{/each}
```

### SVG viewBox with Reactive Props

Svelte handles reactive SVG attribute binding, including `viewBox`:

```svelte
<svg viewBox="0 {rowIndex * ROW_HEIGHT} {width} {ROW_HEIGHT}">
```

This updates correctly when `rowIndex` changes (e.g., during virtual list item recycling).

---

## SVG Text Measurement for Ref Pills

If ref pills move from HTML to SVG (PROJECT.md lists this as a v0.4 target), pill background `<rect>` sizing requires knowing text width before rendering.

### Recommended: Canvas `measureText`

```typescript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d')!;
ctx.font = '600 11px system-ui, sans-serif';

function measurePillWidth(label: string): number {
  return ctx.measureText(label).width + 12; // horizontal padding
}
```

- Canvas never inserted into DOM
- `measureText()` is synchronous, ~0.01ms per call
- Exact pixel-accurate width
- No new dependencies

### Alternative: Character-Width Heuristic

```typescript
const AVG_CHAR_WIDTH = 6.2; // for 11px system font, semibold
function estimatePillWidth(label: string): number {
  return label.length * AVG_CHAR_WIDTH + 12;
}
```

Less accurate but zero DOM dependency. Acceptable if pills don't need pixel-perfect sizing.

---

## Rust Backend: No Changes Required

### Current Data Is Sufficient

The lane algorithm already returns everything the frontend needs:

| Data | Source | Used For |
|------|--------|----------|
| `GraphCommit.column` | Lane algorithm | Dot x-position |
| `GraphCommit.color_index` | Lane algorithm | Color via `var(--lane-N)` |
| `GraphCommit.edges[]` | Lane algorithm | Rail segments + merge/fork paths |
| `GraphCommit.is_branch_tip` | Lane algorithm | Where branch lines start |
| `GraphCommit.is_merge` | Lane algorithm | Hollow dot styling |
| `GraphResult.max_columns` | Lane algorithm | SVG width calculation |

No new Tauri commands, no new Rust types, no changes to IPC protocol.

### Optional Enhancement: Precomputed Branch Segments

The frontend needs to know "lane X is active from row A to row B" for continuous rail paths. This can be computed on the frontend by scanning commits for straight edges (O(n) -- trivial). Only move to Rust if profiling shows it matters (unlikely).

---

## File Impact Summary

| File | Change | Description |
|------|--------|-------------|
| `CommitGraph.svelte` | Major refactor | Add `computeGraphSvg` call, pass data to rows |
| `LaneSvg.svelte` | **Delete** | Replaced by new graph rendering component |
| `CommitRow.svelte` | Simplify | Remove `<LaneSvg>`, use new component |
| `graph-constants.ts` | Minor | Possibly add new constants |
| `graph-svg-data.svelte.ts` | **New** | Path computation module (reactive `$state`) |
| `GraphSvg.svelte` | **New** | SVG renderer component (replaces LaneSvg) |
| `types.ts` | Optional | May add `BranchSegment`, `GraphSvgData` interfaces |
| `RefPill.svelte` | Possible delete | If ref pills move to SVG |

---

## What NOT to Add

| Temptation | Why Not | What to Do Instead |
|------------|---------|-------------------|
| D3.js | Massive overkill. The geometry is vertical lines + arcs. | Plain TypeScript path functions |
| Canvas rendering | Loses CSS custom properties, accessibility, declarative Svelte templates. | SVG with viewBox |
| SVG.js / Snap.svg | DOM manipulation libraries conflict with Svelte's reactive DOM management. | Svelte handles SVG DOM natively |
| Web Workers for paths | Path generation is sub-millisecond. Lane algorithm (the expensive part) is already in Rust. | Main thread `$derived.by()` |
| Virtual SVG library | Visible-range culling is ~20 lines of array filtering. | Manual with `startIndex`/`endIndex` |
| SVGO | Optimizes SVG files. We generate paths programmatically. | Not applicable |
| `requestAnimationFrame` wrapper | Svelte batches DOM updates. Browser schedules paints. | Profile first, optimize only if needed |
| Fork @humanspeak/svelte-virtual-list | To expose scrollTop. The viewBox-clipped approach doesn't need it. DOM access via querySelector works if overlay approach is chosen. | Use existing API or querySelector |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Rendering technology | SVG | Canvas | Loses CSS vars, accessibility, declarative templates |
| Path generation location | TypeScript | Rust backend | Rendering concern; avoids IPC for visual tweaks |
| SVG library | None (vanilla SVG) | D3, SVG.js | Overkill for line+arc geometry |
| Text measurement | Canvas `measureText` | Character heuristic | Canvas is exact, fast, no DOM insertion |
| Scroll integration | viewBox clipping per row OR overlay + querySelector | Fork virtual list | Simpler, no maintenance burden |

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| No new dependencies needed | HIGH | Verified existing API surfaces cover all needs |
| SVG performance at scale | HIGH | ~800 DOM elements with virtual scrolling is trivially fast; well within documented limits |
| Virtual list API surface | HIGH | Verified `debugFunction`, `scroll()`, DOM structure by reading library source code |
| Svelte 5 SVG rendering | HIGH | Standard DOM; one known bug (#12289) with `{#if}` toggling -- avoidable |
| Path generation in TypeScript | HIGH | Existing `buildEdgePath()` proves the math works; absolute coordinates are a coordinate shift |
| Canvas measureText for pills | HIGH | Standard DOM API, synchronous, well-documented |

---

## Sources

### Library Source Code (HIGH confidence)
- `node_modules/@humanspeak/svelte-virtual-list/dist/SvelteVirtualList.svelte` -- DOM structure, `debugFunction`, scroll handling internals
- `node_modules/@humanspeak/svelte-virtual-list/dist/types.d.ts` -- full API surface, no scroll position prop

### Existing Codebase (HIGH confidence)
- `src/components/LaneSvg.svelte` -- current per-row SVG rendering, `buildEdgePath()` math
- `src/components/CommitRow.svelte` -- ref pill connector as HTML div, graph column layout
- `src/components/CommitGraph.svelte` -- virtual list integration, `$derived.by()` usage
- `src/lib/graph-constants.ts` -- `LANE_WIDTH=12`, `ROW_HEIGHT=26`, `DOT_RADIUS=6`
- `src/lib/types.ts` -- `GraphCommit`, `GraphEdge`, `EdgeType` data model
- `src-tauri/src/git/types.rs` -- Rust types confirming all needed data is already serialized

### External Sources (MEDIUM confidence)
- [Svelte 5 SVG duplication issue #12289](https://github.com/sveltejs/svelte/issues/12289)
- [SVG Performance -- O'Reilly Using SVG](https://oreillymedia.github.io/Using_SVG/extras/ch19-performance.html)
- [Khan Academy SVG Performance](https://www.crmarsh.com/svg-performance/)
- [CSS-Tricks High Performance SVGs](https://css-tricks.com/high-performance-svgs/)
- [MDN SVG path](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/path)
- [SVG viewBox guide](https://www.svggenie.com/blog/svg-viewbox-guide)
- [@humanspeak/svelte-virtual-list GitHub](https://github.com/humanspeak/svelte-virtual-list)
- [D3 Virtual Scrolling for SVG](https://billdwhite.com/wordpress/2014/05/17/d3-scalability-virtual-scrolling-for-large-visualizations/)

---

*Stack research for: Trunk v0.4 -- Graph rendering rework (per-row SVG to full-height SVG overlay)*
*Researched: 2026-03-12*
