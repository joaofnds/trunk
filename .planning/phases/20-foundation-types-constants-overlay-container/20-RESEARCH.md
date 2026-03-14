# Phase 20: Foundation — Types, Constants & Overlay Container - Research

**Researched:** 2026-03-13
**Domain:** SVG overlay inside virtualized scroll container, TypeScript types, graph constants
**Confidence:** HIGH

## Summary

This phase proves a critical architectural decision: can a single SVG element live inside a virtual list's scroll container, scroll natively with content, and pass pointer events through to HTML rows beneath? The research examines the existing `@humanspeak/svelte-virtual-list` DOM structure to determine exactly where the SVG overlay should be injected, confirms that `pointer-events: none` on SVG root with selective `pointer-events: auto` on interactive elements is a well-supported CSS pattern, and defines the new TypeScript types and constants needed.

The virtual list uses a four-layer DOM structure: container → viewport (scrollable) → content (full-height) → items (translated). The SVG overlay must be a sibling of the items div inside the content div, positioned absolutely to span the full content height. This placement means the SVG scrolls natively with content (OVRL-02) and requires zero JavaScript scroll synchronization. The content div already has `position: relative` in the library CSS, making it the perfect positioning context.

**Primary recommendation:** Vendor `@humanspeak/svelte-virtual-list` (1731-line `.svelte` file + utilities), strip unused features, add an overlay snippet slot inside the content div. Define `GraphNode`, `GraphEdge` (overlay-specific), and `GraphData` types in `types.ts`. Update constants in `graph-constants.ts` with new values but keep old values active until Phase 24.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Raw SVG with Svelte 5 reactivity — zero visualization dependencies
- No D3, Canvas, SVG.js, or any other library — all capabilities are browser primitives
- SVG elements rendered declaratively via Svelte `{#each}` over visible range
- `pointer-events: none` on SVG root, `pointer-events: auto` on individually interactive elements (ref pills in Phase 26)
- Vendor `@humanspeak/svelte-virtual-list` into `src/components/` (single file, ~1700 lines)
- Trim to essentials — strip unused features (horizontal scrolling, grid mode, sticky headers)
- Add an overlay slot inside the scroll container for the SVG element
- SVG lives inside the scroll container (scrolls natively with content — zero JS scroll sync)
- SVG is positioned absolute within the scrollable content area, sized to full content height
- HTML commit rows handle all click/right-click interactions beneath the SVG
- `ROW_HEIGHT`: 26px → 36px
- `LANE_WIDTH`: 12px → 16px
- `DOT_RADIUS`: Claude's discretion (current 6px fills entire lane; smaller relative to 16px lane preferred)
- Define new constants in Phase 20, apply in Phase 24 — current rendering pipeline keeps old values until integration
- Both scroll performance AND pointer passthrough must pass — either failing is a deal-breaker
- If gate fails: stop and consult — do not auto-fallback

### Claude's Discretion
- Exact dot radius value (within the "smaller relative to lane" preference)
- Exact SVG element placement within the vendored scroll container DOM
- Which virtual list features to trim vs keep during vendoring
- Edge stroke widths and visual constants not specified above
- How to structure the overlay slot API in the vendored component

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OVRL-01 | Single SVG element spans entire graph height, positioned inside virtual list scroll container | DOM structure analysis shows SVG should be absolute-positioned child of `.virtual-list-content` div (which already has `position: relative`). Sized via `height: {contentHeight}px; width: {graphWidth}px` |
| OVRL-02 | SVG overlay scrolls natively with virtual list content (zero JS scroll sync) | Confirmed: placing SVG inside the content div means it participates in native scrolling. The viewport div (`overflow-y: scroll`) scrolls both the items div and the SVG overlay together |
| OVRL-03 | SVG root has `pointer-events: none`, HTML commit rows handle all click/right-click interactions beneath | CSS `pointer-events: none` on SVG root makes it transparent to mouse events. All existing click/contextmenu handlers on CommitRow continue working. Pattern is well-supported across all browsers |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5.x | Component framework | Already in use, `$derived.by()` and snippet patterns established |
| @humanspeak/svelte-virtual-list | 0.4.2 (vendored) | Virtual scrolling | Already in use; vendoring gives DOM control for overlay slot |
| SVG (browser native) | N/A | Graph rendering | Zero-dependency decision; all browsers support SVG with `pointer-events` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| vitest | 4.1.0 | Unit testing | Already configured; test new types and constants |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Vendoring virtual list | Fork on npm | Vendoring is simpler for a single-file modification; no npm publish overhead |
| SVG overlay inside scroll | SVG overlay outside scroll + JS sync | JS sync adds complexity, frame drops, and jank — native scroll is zero-cost |
| `pointer-events: none` | z-index layering (SVG behind HTML) | z-index alone can't work because SVG must render ON TOP of rows visually but pass events THROUGH |

## Architecture Patterns

### Virtual List DOM Structure (Current)
```
.virtual-list-container          ← positioning context, overflow:hidden
  .virtual-list-viewport         ← overflow-y:scroll (THE scroll container)
    .virtual-list-content        ← position:relative, height:{contentHeight}px
      .virtual-list-items        ← position:absolute, transform:translateY({transformY}px)
        [item divs]              ← rendered commit rows
```

### Virtual List DOM Structure (After Vendoring — With Overlay)
```
.virtual-list-container          ← positioning context, overflow:hidden
  .virtual-list-viewport         ← overflow-y:scroll (THE scroll container)
    .virtual-list-content        ← position:relative, height:{contentHeight}px
      {#if overlaySnippet}
        {@render overlaySnippet(contentHeight)}   ← NEW: overlay slot
      {/if}
      .virtual-list-items        ← position:absolute, transform:translateY({transformY}px)
        [item divs]              ← rendered commit rows
```

### SVG Overlay Placement Pattern
**What:** A single `<svg>` element positioned absolutely inside the scroll content area
**When to use:** When you need a rendering layer that scrolls with content but doesn't intercept events
**Example:**
```svelte
<!-- Inside CommitGraph.svelte, passed as overlay snippet -->
{#snippet graphOverlay(contentHeight)}
  <svg
    class="graph-overlay"
    width={graphWidth}
    height={contentHeight}
    style="position: absolute; top: 0; left: 0; pointer-events: none;"
  >
    <!-- Future phases render paths, dots, etc. here -->
  </svg>
{/snippet}

<VirtualList items={displayItems} {overlaySnippet}>
  {#snippet renderItem(commit, index)}
    <CommitRow ... />
  {/snippet}
</VirtualList>
```

### Pointer Events Passthrough Pattern
**What:** CSS `pointer-events: none` makes an element invisible to mouse/touch events
**When to use:** Overlay elements that should not block interaction with elements beneath
**Example:**
```svelte
<!-- SVG root: pointer-events: none — clicks pass through -->
<svg style="pointer-events: none;">
  <!-- Most elements inherit none — invisible to mouse -->
  <path d="..." fill="none" stroke="blue" />
  <circle cx="10" cy="10" r="4" />

  <!-- Exception: ref pills in Phase 26 get pointer-events: auto -->
  <!-- <rect style="pointer-events: auto" ... /> -->
</svg>
```

### New Type Definitions Pattern
**What:** Overlay-specific types that extend existing types
**When to use:** When the overlay needs its own coordinate system
```typescript
// New types for the overlay coordinate system (global grid coordinates)
export interface OverlayNode {
  oid: string;
  x: number;       // swimlane index (integer)
  y: number;       // row index (integer)
  colorIndex: number;
  isMerge: boolean;
  isBranchTip: boolean;
  isStash: boolean;
  isWip: boolean;
}

export interface OverlayEdge {
  fromX: number;    // swimlane index
  fromY: number;    // row index
  toX: number;      // swimlane index
  toY: number;      // row index
  colorIndex: number;
  dashed: boolean;
}

export interface OverlayGraphData {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
  maxColumns: number;
}
```

### Anti-Patterns to Avoid
- **JavaScript scroll synchronization:** Never use `onscroll` to update SVG position. The SVG is INSIDE the scroll container — it scrolls for free.
- **Re-implementing virtual list from scratch:** The vendored component handles height estimation, resize observation, infinite scroll, and programmatic scrolling. Trim features, don't rewrite.
- **Putting SVG in the viewport div (sibling of content):** This would make the SVG fixed relative to the viewport, not scrolling with content.
- **Applying new constants immediately:** Phase 20 defines them but Phase 24 applies them. Changing ROW_HEIGHT now would break the entire rendering pipeline.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Virtual scrolling | Custom scroll virtualization | Vendored `@humanspeak/svelte-virtual-list` | Height estimation, resize observation, infinite scroll, programmatic scroll — hundreds of edge cases |
| Pointer event passthrough | Custom event forwarding/bubbling | CSS `pointer-events: none` | Browser-native, zero JS, zero performance cost |
| Scroll synchronization | JS scroll event handlers | Native scroll (SVG inside scroll container) | Zero-latency, zero-jank, browser-optimized |

**Key insight:** The entire overlay approach works because of two browser primitives: (1) elements inside a scroll container scroll with it for free, and (2) `pointer-events: none` is inherited by child SVG elements. No custom code needed for either.

## Common Pitfalls

### Pitfall 1: SVG in Wrong DOM Position
**What goes wrong:** SVG doesn't scroll with content, or scrolls at wrong rate
**Why it happens:** Placing SVG as sibling of content div (inside viewport but outside content) makes it scroll independently
**How to avoid:** SVG must be a child of `.virtual-list-content` (the div with `height: {contentHeight}px`)
**Warning signs:** SVG and rows visually misaligned during scroll

### Pitfall 2: SVG Blocking Click Events
**What goes wrong:** Clicks on commit rows stop working after adding SVG overlay
**Why it happens:** SVG element sits on top of rows in DOM order; without `pointer-events: none`, it captures all mouse events
**How to avoid:** Add `pointer-events: none` to SVG root element. Verify with right-click context menu test.
**Warning signs:** Context menu stops appearing, row selection stops working

### Pitfall 3: Applying New Constants Too Early
**What goes wrong:** Existing graph rendering breaks — rows misaligned, dots wrong size
**Why it happens:** `graph-constants.ts` is imported by `GraphCell.svelte`, `CommitRow.svelte`, `graph-svg-data.ts`, and their tests
**How to avoid:** Export new constants under different names (e.g., `OVERLAY_ROW_HEIGHT`, `OVERLAY_LANE_WIDTH`, `OVERLAY_DOT_RADIUS`). Keep existing constants unchanged.
**Warning signs:** Visual regression in current graph rendering

### Pitfall 4: Vendored Component Breaks Existing Functionality
**What goes wrong:** Virtual list behavior changes (scroll position, load-more, programmatic scroll)
**Why it happens:** Over-trimming during vendoring removes critical logic
**How to avoid:** First vendor as-is, verify existing functionality, THEN trim incrementally. Test `loadMore`, `scroll({index})`, and infinite scroll after each trim pass.
**Warning signs:** Scroll-to-HEAD stops working, infinite scroll breaks, height estimation fails

### Pitfall 5: SVG Height Mismatch with Content
**What goes wrong:** SVG doesn't cover all rows, or extends past content
**Why it happens:** SVG height hardcoded or computed differently than virtual list's contentHeight
**How to avoid:** Use the same `contentHeight` value the virtual list uses for its content div. The overlay snippet receives this value.
**Warning signs:** Graph lines end prematurely, or extra blank space at bottom

### Pitfall 6: Performance Regression from Large SVG
**What goes wrong:** Scroll jank, frame drops
**Why it happens:** SVG element spans full content height with all elements rendered (not virtualized)
**How to avoid:** In Phase 20, the SVG is empty (proof of concept). Phase 23 adds SVG virtualization (OVRL-04). For the decision gate, test with an empty or minimal SVG to isolate scroll/pointer performance.
**Warning signs:** DevTools Performance tab shows long paint/composite times during scroll

## Code Examples

### Vendored Virtual List with Overlay Slot

The key modification to the vendored component — adding an overlay snippet prop and rendering it:

```svelte
<!-- In vendored SvelteVirtualList.svelte -->
<script lang="ts" generics="TItem = unknown">
  // ... existing props ...
  const {
    // ... existing props ...
    overlaySnippet,  // NEW: optional overlay snippet
  }: SvelteVirtualListProps<TItem> = $props()
</script>

<!-- In template, inside .virtual-list-content -->
<div
  id="virtual-list-content"
  class={contentClass ?? 'virtual-list-content'}
  style:height="{contentHeight}px"
>
  <!-- NEW: Overlay slot rendered before items (behind in paint order, but on top via z-index or absolute positioning) -->
  {#if overlaySnippet}
    {@render overlaySnippet(contentHeight)}
  {/if}

  <!-- Existing items container -->
  <div
    id="virtual-list-items"
    class={itemsClass ?? 'virtual-list-items'}
    style:transform="translateY({transformY}px)"
  >
    <!-- ... existing item rendering ... -->
  </div>
</div>
```

### New Constants (Alongside Existing)

```typescript
// graph-constants.ts
// Current values — used by existing rendering pipeline until Phase 24
export const LANE_WIDTH = 12;
export const ROW_HEIGHT = 26;
export const DOT_RADIUS = 6;
export const EDGE_STROKE = 1;
export const WIP_STROKE = 1.5;
export const MERGE_STROKE = 2;

// Overlay values — used by new overlay pipeline starting Phase 21
export const OVERLAY_LANE_WIDTH = 16;
export const OVERLAY_ROW_HEIGHT = 36;
export const OVERLAY_DOT_RADIUS = 4;  // Smaller relative to 16px lane (25% of lane vs 50%)
export const OVERLAY_EDGE_STROKE = 1.5;
export const OVERLAY_MERGE_STROKE = 2;
```

### Decision Gate Test Structure

```svelte
<!-- In CommitGraph.svelte — proof-of-concept overlay -->
{#snippet graphOverlay(contentHeight)}
  <svg
    class="absolute top-0 left-0"
    width={Math.max(maxColumns, 1) * LANE_WIDTH}
    height={contentHeight}
    style="pointer-events: none; z-index: 1;"
  >
    <!-- Minimal test content: a colored rect to verify scroll sync -->
    <rect x="0" y="0" width="100%" height="100%" fill="rgba(255,0,0,0.05)" />
  </svg>
{/snippet}
```

### Type Definitions to Add

```typescript
// In types.ts — new overlay types
// These represent the output of the Active Lanes transformation (Phase 21)
// which converts GraphCommit[] into a global grid coordinate system

export interface OverlayNode {
  oid: string;
  x: number;           // swimlane index (column)
  y: number;           // row index
  colorIndex: number;
  isMerge: boolean;
  isBranchTip: boolean;
  isStash: boolean;
  isWip: boolean;
}

export interface OverlayEdge {
  fromX: number;        // source swimlane
  fromY: number;        // source row
  toX: number;          // target swimlane
  toY: number;          // target row
  colorIndex: number;
  dashed: boolean;
}

export interface OverlayGraphData {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
  maxColumns: number;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-row viewBox-clipped SVGs | Single SVG overlay | v0.5 (this milestone) | Enables continuous bezier curves across rows, eliminates per-row SVG overhead |
| Manhattan routing (H/A/V) | Cubic bezier curves (Phase 22) | v0.5 | Smoother visual curves, requires overlay for continuous paths |
| ROW_HEIGHT=26, LANE_WIDTH=12 | ROW_HEIGHT=36, LANE_WIDTH=16 | v0.5 Phase 20/24 | 38% more breathing room, proportional to GitKraken-style spacing |

**Deprecated/outdated:**
- `GraphCell.svelte`: Will be superseded by the overlay SVG. Kept during transition but eventually removed.
- `LaneSvg.svelte`: Already unused (import removed in Phase 17-02), file preserved for reference only.
- `computeGraphSvgData()` per-row key scheme: Current `{oid}:straight:{col}` key format is designed for per-row viewBox clipping. The overlay approach will need a different rendering strategy (Phase 22/23).

## Vendoring Strategy

### What to Vendor
The dist file at `node_modules/@humanspeak/svelte-virtual-list/dist/SvelteVirtualList.svelte` (1731 lines) plus its utility dependencies:
- `utils/heightCalculation.js`
- `utils/raf.js`
- `utils/heightChangeDetection.js`
- `utils/virtualList.js`
- `utils/virtualListDebug.js`
- `utils/scrollCalculation.js`
- `utils/throttle.js`
- `utils/perfMetrics.js` (re-exported from index)
- `reactive-list-manager/index.js`
- `types.js` / `types.d.ts`

### Features to KEEP
- Top-to-bottom scrolling mode (the only mode used)
- Dynamic height estimation and caching
- `onLoadMore` / `hasMore` infinite scroll
- `scroll()` programmatic scrolling (used for scroll-to-HEAD)
- `bufferSize` configuration
- `renderItem` snippet
- ResizeObserver for items and container
- `defaultEstimatedItemHeight` prop

### Features to TRIM
- `bottomToTop` mode and all associated logic (~40% of component code)
- `wasAtBottomBeforeHeightChange` / bottom-anchoring correction logic
- `anchorModeEnabled` / `reconcileToAnchorIfEnabled` 
- `batchUpdatesEnabled` / `runInBatch`
- `idleCorrectionsOnly` feature flag
- `INTERNAL_DEBUG` / package-specific debug env vars (keep `debug` prop)
- `containerClass`, `viewportClass`, `contentClass`, `itemsClass` class props (use hardcoded classes)
- `testId` data attribute props (not used in Trunk)
- `debugFunction` prop (not used)
- `scrollToIndex` deprecated method
- `perfMetrics` exports

### What to ADD
- `overlaySnippet` prop: `Snippet<[contentHeight: number]>` — rendered inside content div
- Export `contentHeight` value for external use (already computed internally as `contentHeight`)

## Decision Gate Criteria

### Pass Criteria
1. **Scroll performance:** Smooth 60fps scrolling with empty SVG overlay present. No visible jank compared to current behavior. Test on normal repos.
2. **Pointer passthrough:** Clicks on commit rows work. Right-click context menus appear. Row selection works. All through the SVG overlay.

### How to Test
1. **Scroll:** Open a repo with 500+ commits. Scroll rapidly up and down. Compare feel to current (no overlay) behavior. Check DevTools Performance tab for frame drops.
2. **Pointer:** Click rows to select commits. Right-click for context menu. Verify WIP row click. Verify stash row context menu.

### Failure Scenarios
- **Scroll fails:** SVG causes compositor layer issues. Mitigation: try `will-change: transform` on SVG, or `contain: strict` on content div.
- **Pointer fails:** Events not reaching rows. Mitigation: verify `pointer-events: none` is applied, check z-index stacking.
- **If either fails:** STOP. Do not implement fallback. Consult user about enhanced per-row viewBox approach.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | `vite.config.ts` (test section) |
| Quick run command | `npx vitest run` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OVRL-01 | SVG spans full graph height inside scroll container | manual | Visual inspection: SVG element present in DOM, height matches contentHeight | ❌ Manual |
| OVRL-02 | SVG scrolls natively with content | manual | Visual inspection: scroll and verify SVG moves with rows | ❌ Manual |
| OVRL-03 | Pointer events pass through SVG to HTML rows | manual | Click rows, right-click for context menu through overlay | ❌ Manual |
| — | New overlay types export correctly | unit | `npx vitest run src/lib/types.test.ts` | ❌ Wave 0 |
| — | New overlay constants have correct values | unit | `npx vitest run src/lib/graph-constants.test.ts` | ❌ Wave 0 |
| — | Existing graph-svg-data tests still pass | unit | `npx vitest run src/lib/graph-svg-data.test.ts` | ✅ Exists |

### Sampling Rate
- **Per task commit:** `npx vitest run`
- **Per wave merge:** `npx vitest run` + manual scroll/click test
- **Phase gate:** Full suite green + decision gate manual test

### Wave 0 Gaps
- [ ] `src/lib/graph-constants.test.ts` — verify new overlay constants exist and have expected values
- [ ] Existing `src/lib/graph-svg-data.test.ts` must continue passing (no changes to existing constants)

*Note: OVRL-01, OVRL-02, OVRL-03 are inherently manual/visual tests (DOM placement, scroll behavior, pointer passthrough). They constitute the decision gate and are verified by running the app.*

## Open Questions

1. **Exact DOT_RADIUS value**
   - What we know: Current 6px fills entire 12px lane (50%). New lane is 16px. User wants "smaller relative to lane."
   - Recommendation: 4px (25% of lane width). This matches GitKraken proportions where dots are visually subordinate to the lane structure. Provides clear space for bezier curves. Can be tuned later.

2. **Overlay snippet position relative to items div**
   - What we know: SVG must be inside `.virtual-list-content`. Could go before or after `.virtual-list-items`.
   - Recommendation: Place BEFORE items div in DOM order. With `position: absolute` on the SVG, DOM order doesn't affect visual layering — `z-index` controls that. But placing it first is semantically cleaner (background layer first).

3. **How much to trim from virtual list in this phase**
   - What we know: The component is 1731 lines. bottomToTop mode accounts for significant complexity.
   - Recommendation: Vendor as-is first, verify functionality, trim in a separate task. This reduces risk of introducing bugs during the same phase that adds the overlay.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `node_modules/@humanspeak/svelte-virtual-list/dist/SvelteVirtualList.svelte` — four-layer DOM structure (lines 1639-1689), CSS positioning (lines 1691-1730)
- Codebase analysis: `src/components/CommitGraph.svelte` — current virtual list usage (lines 419-430), context pattern (line 271)
- Codebase analysis: `src/components/GraphCell.svelte` — current per-row SVG rendering
- Codebase analysis: `src/lib/types.ts` — existing type definitions
- Codebase analysis: `src/lib/graph-constants.ts` — current constant values
- CSS specification: `pointer-events: none` — universally supported, inherited by SVG children

### Secondary (MEDIUM confidence)
- `@humanspeak/svelte-virtual-list` package.json — version 0.4.2, Svelte 5 peer dependency

### Tertiary (LOW confidence)
- None — all findings verified from codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use, no new dependencies
- Architecture: HIGH — DOM structure verified from source code, CSS positioning well-understood
- Pitfalls: HIGH — derived from codebase analysis and established web platform behavior
- Vendoring strategy: HIGH — source file examined, features mapped to usage in CommitGraph.svelte

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable — no external dependencies changing)
