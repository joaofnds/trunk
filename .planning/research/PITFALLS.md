# Domain Pitfalls

**Domain:** Single SVG overlay graph rendering for virtualized commit list (Tauri 2 + Svelte 5 + Rust Git GUI)
**Researched:** 2026-03-13
**Confidence:** HIGH — based on codebase analysis (CommitGraph/CommitRow/GraphCell/graph-svg-data.ts), v0.4 architecture research, project retrospective patterns, and SVG/WebKit performance knowledge

---

## Context: What's Changing in v0.5

v0.4 successfully replaced per-row path **fragments** with continuous **path data** (single `d`-string per edge spanning multiple rows), but kept the **per-row viewBox-clipped SVG rendering model** — each visible row renders its own `<svg>` with `viewBox` clipping into a shared coordinate space.

v0.5 reverses the v0.4 decision to keep per-row SVGs. The milestone explicitly targets:
- **Single SVG overlay** spanning the full graph height (not per-row fragments)
- **TypeScript transformation layer** on top of Rust lane algorithm output
- **Cubic bezier curves** replacing Manhattan routing
- **Ref pills migrated from HTML to SVG**
- **Preserving all click/context menu interactions** under the overlay

This reversal of a deliberate v0.4 scoping decision ("Full-height single SVG — out of scope citing DOM explosion at scale") is the single highest-risk aspect of v0.5. The original concern was valid. v0.5 must prove it can be mitigated.

---

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

---

### Pitfall 1: Full-Height SVG DOM Explosion — The Unresolved v0.4 Concern

**What goes wrong:**
A single SVG element spanning the entire graph height contains one `<path>` per edge, one `<path>` per rail, one `<circle>` per commit, and optionally ref pill elements — for ALL loaded commits, not just visible ones. With 10,000 loaded commits, 8 active lanes, and frequent merges, the SVG could contain 20,000-50,000 child elements. WebKit layout/paint degrades, memory grows without bound on `loadMore()`, and style recalculation blocks the main thread.

**Why it happens:**
The per-row viewBox-clipped model naturally virtualizes because `@humanspeak/svelte-virtual-list` keeps only ~40 rows in the DOM. Moving to a single SVG OUTSIDE this virtualization breaks that guarantee. Developers assume "it's just paths" but each `<path>` is a full DOM node with style computation, bounding box calculation, and hit-testing surface. The v0.4 decision explicitly cited this risk.

**Consequences:**
- Jank increases linearly as `loadMore()` appends batches (200 commits × N batches)
- Memory usage grows without bound (no commit data is ever freed)
- DevTools shows SVG with 10,000+ children
- "Recalculate Style" exceeds 16ms per frame in the SVG subtree

**Prevention:**
1. **SVG virtualization is mandatory.** The overlay SVG must render only paths/dots for the visible window + a buffer (2-3 viewport heights). This is the "SVG virtualization" approach documented in the v0.4 PITFALLS.md.
2. Use scroll position to compute visible row range: `startRow = floor(scrollTop / ROW_HEIGHT) - buffer`, `endRow = ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + buffer`.
3. Cull all path elements outside this range. A bezier curve spanning rows 5-8 is only rendered when at least one of rows 5-8 is in the visible range.
4. Re-render SVG content on scroll. Path computation is <1ms for ~100 visible elements. The browser does NOT need to traverse 50,000 elements.
5. The pre-computed `rowEdgeIndex: Map<number, ContinuousEdge[]>` from v0.4 architecture enables O(1) lookup per visible row.
6. **Hard limit:** SVG child count must stay under 500 regardless of total loaded commits. Profile with `document.querySelector('svg.graph-overlay').childElementCount`.

**Detection:**
- DevTools Elements panel shows SVG with >500 children
- Performance profiler shows "Layout" or "Recalculate Style" >16ms in SVG subtree
- Jank increases after each `loadMore()` call

**Phase to address:**
Phase 1 (foundation). The SVG container setup and virtualization strategy must be the FIRST thing built. Getting this wrong means the entire overlay approach fails — validating the original v0.4 out-of-scope decision.

---

### Pitfall 2: Scroll Synchronization Between SVG Overlay and Virtual List

**What goes wrong:**
The SVG overlay and the virtual list's scroll container fall out of sync. Lane lines don't align with their commit rows. Symptoms: visual offset that grows as you scroll, sub-pixel jitter during fast trackpad flick, snap-to-wrong-position after scroll momentum ends.

**Why it happens:**
`@humanspeak/svelte-virtual-list` manages its own scroll container (`.virtual-list-viewport` with `overflow-y: scroll`). The library does NOT expose `scrollTop` as a prop or binding (verified in v0.4 STACK.md research). If the SVG is positioned separately, synchronization requires reading `scrollTop` via DOM access and writing it to the SVG — introducing a one-frame lag because scroll events fire asynchronously.

The library's internal DOM structure:
```
div.virtual-list-container  (position: relative; overflow: hidden)
  div.virtual-list-viewport  (overflow-y: scroll; onscroll internal)
    div.virtual-list-content  (height: {contentHeight}px)
      div.virtual-list-items  (transform: translateY({transformY}px))
```

`transformY` is internal state — not exposed. An overlay SVG cannot know the transform offset without reading DOM.

**Consequences:**
- Graph lines misalign with commit dots by 1-2px after fast scroll
- Visible "snap" correction when scroll momentum ends
- Lines align correctly only after a brief delay (one-frame lag)
- Dual-scroll containers may produce mismatched inertial scrolling on trackpad

**Prevention:**
1. **Place the SVG INSIDE the virtual list's scroll container.** This requires either:
   - Accessing `.virtual-list-viewport` via `querySelector` and injecting the SVG as a child (brittle but functional)
   - Wrapping both the virtual list and SVG in a shared scroll container, disabling the virtual list's own scrolling (requires understanding library internals)
   - Using the `debugFunction` callback (provides `startIndex`, `endIndex`) to derive scroll position indirectly
2. If using an overlay outside the scroll container: use `position: sticky; top: 0` within the scroll container so the SVG scrolls naturally with the list.
3. **AVOID any approach that reads `scrollTop` from one element and writes it to another via JS.** This always produces visible lag.
4. If DOM injection is unavoidable, listen for `scroll` events on the viewport element and update `viewBox` in the same microtask (not `requestAnimationFrame`).

**Detection:**
- Any code that reads `scrollTop` from one element and applies to another
- Graph lines misalign by 1-2px after fast trackpad scroll
- Visible "snap" correction when scroll momentum ends

**Phase to address:**
Phase 1 (foundation). This is the make-or-break architectural decision. The v0.4 ARCHITECTURE.md rejected the overlay approach specifically because of this risk — v0.5 must prove a working solution before any path rendering begins.

---

### Pitfall 3: Pointer Events Swallowed by SVG Overlay

**What goes wrong:**
The single SVG overlay sits on top of the HTML commit rows in the graph column. All click, hover, and context-menu events on rows within the graph area stop working. The existing right-click context menu (Copy SHA, Checkout, Cherry-pick, Revert, Reset) silently breaks. Row hover highlighting disappears. Commit selection on click stops working.

**Why it happens:**
A positioned SVG element creates its own stacking context. When it overlaps HTML elements, it captures all pointer events by default. The entire graph column area is covered by the SVG.

The current interaction chain is:
1. `CommitRow.svelte` line 48: `onclick={() => onselect?.(commit.oid)}`
2. `CommitRow.svelte` line 49: `oncontextmenu={(e) => { ... oncontextmenu(e, commit); }}`
3. `CommitRow.svelte` line 47: `hover:bg-[var(--color-surface)]`

ALL of these fire on the HTML `<div>` row. The SVG overlay intercepts them before they reach the row.

**Consequences:**
- Commit rows stop responding to click within graph column area
- Context menu stops appearing on right-click within graph column area
- Row hover background disappears in the graph area
- Selection works only when clicking on message/author/date/SHA columns

**Prevention:**
1. Set `pointer-events: none` on the SVG root element.
2. Set `pointer-events: auto` ONLY on interactive SVG children (commit dots if they need direct click handling, ref pills if migrated to SVG).
3. **Preferred approach:** Keep ALL interactive targets on HTML rows. The SVG is purely visual. The commit dot in SVG is visual-only; the HTML row `<div>` handles all clicks/hover/context-menu.
4. Mark the SVG as `aria-hidden="true"` — it is a decorative visual representation.
5. Scope the SVG overlay to cover ONLY the graph column width, not the full row width.
6. Test every interaction after adding the overlay: row click, row hover, right-click context menu, WIP row click, stash context menu.

**Detection:**
- Commit rows stop responding to click/hover after SVG overlay is added
- Context menu stops appearing on right-click within graph column
- Row hover background disappears in graph area

**Phase to address:**
Phase 1 (foundation), re-verified at every subsequent phase. Every new SVG interactive element must be tested for pointer-event pass-through.

---

### Pitfall 4: Cubic Bezier Control Points Produce Ugly Curves at Adjacent Rows

**What goes wrong:**
Cubic bezier curves (`C` command) from a child commit to a parent commit look fine when the commits are 5+ rows apart, but produce ugly, kinked, or overly flat curves when commits are adjacent (1-2 rows apart). This is the most common case — most merge/fork edges connect adjacent rows. The graph looks worse than the Manhattan routing it replaced.

**Why it happens:**
The bezier control point offset is typically computed as a percentage of vertical distance:
```typescript
const cpOffset = vertDist * 0.4; // 40% tension
```
For adjacent rows with `ROW_HEIGHT = 34px` (v0.5 target), `vertDist = 34px` and `cpOffset = 13.6px`. With a cross-column horizontal distance of, say, 3 lanes × 16px = 48px, the control point offset is too small relative to the horizontal distance. The resulting curve is nearly a straight diagonal line with slight wobble — not the smooth waterfall that GitKraken produces.

For same-row or 2-row edges with large horizontal distance (e.g., from column 0 to column 7), the bezier degenerates into a nearly flat line.

**Consequences:**
- Merge/fork edges look like kinked diagonals, not smooth curves
- Visual regression from Manhattan routing which had clean horizontal-then-vertical segments
- Inconsistent curve aesthetics: smooth for distant commits, ugly for adjacent ones
- Users perceive the new rendering as "worse" than v0.4

**Prevention:**
1. **Use different curve strategies for different vertical distances:**
   - Adjacent rows (1-2 apart): Use a minimum control point offset (e.g., `Math.max(cpOffset, ROW_HEIGHT * 0.7)`) to guarantee curvature
   - Nearby rows (3-5 apart): Standard 40% tension
   - Distant rows (6+ apart): Consider clamping cpOffset so curves don't become too extreme
2. Test with real repositories that have frequent merges at adjacent rows (e.g., repos using squash-merge workflow).
3. **Tune BEZIER_TENSION per-edge, not globally.** A single tension constant produces good results only for one vertical distance.
4. Study GitKraken's curve rendering closely — it uses a "waterfall" style where the curve starts vertical, transitions to horizontal at a fixed depth, then goes vertical again. This may be piecewise (vertical + bezier + vertical) not a single cubic bezier.
5. Build a visual test page with curves at distances 1, 2, 3, 5, 10, 20 rows to verify aesthetics before shipping.

**Detection:**
- Merge edges between adjacent rows look like kinked diagonals
- Curves look different quality at different vertical distances
- Side-by-side comparison with GitKraken shows inferior curve aesthetics

**Phase to address:**
Phase 2 (bezier path computation). This is a pure TypeScript math problem. Build unit tests for edge cases and create a visual testbed.

---

### Pitfall 5: Ref Pills as SVG Elements Lose HTML Layout Capabilities

**What goes wrong:**
Moving ref pills from HTML to SVG breaks text rendering, overflow handling, and the current hover-expand behavior. The existing ref pill system is deeply HTML-dependent:

From `CommitRow.svelte` lines 60-101:
- `overflow: hidden` on container with `bind:clientWidth={refContainerWidth}` (line 67)
- First pill + "+N" overflow badge (line 72-82)
- Hover-to-expand overlay with `clip-path` CSS animation: `inset(0 100% 100% 0)` → `inset(0 0% 0% 0)` (line 89)
- `pointer-events: none/auto` toggle on expand (line 92)
- Tailwind classes for sizing, colors, and hover states

SVG `<text>` has NO:
- `text-overflow: ellipsis`
- `overflow: hidden`
- CSS flexbox
- `clientWidth` binding (must use `getBBox()` which triggers synchronous layout)
- CSS `clip-path` animation on nested content

**Why it happens:**
SVG text rendering is fundamentally different from HTML. SVG has no box model — `<text>` elements have no width, no padding, no overflow behavior. Developers discover this AFTER attempting the migration, when all edge cases surface.

**Consequences:**
- Ref pill text cut off without ellipsis indicator
- "+N" hover expansion stops working
- Ref pills render at wrong size at different DPI/zoom levels
- `getBBox()` calls trigger synchronous layout thrashing
- Lane-colored backgrounds look different between SVG `<rect>` fill and CSS `background`
- `refHovered` hover state machinery breaks (no equivalent in SVG for `onmouseenter`/`onmouseleave` on complex nested structures)

**Prevention:**
1. **Keep ref pills as HTML elements.** The ref column is already a separate column from the graph column in the current 6-column layout. Ref pills do NOT need to be inside the SVG.
2. Only the connector line (from ref pill to commit dot) needs to cross the column boundary. This can be a `<line>` in the SVG overlay or a CSS positioned `<div>` (as it currently is — `CommitRow.svelte` line 55-57).
3. If the project spec REQUIRES SVG ref pills (PROJECT.md says "Ref pills as SVG elements"), use `<foreignObject>` to embed existing HTML markup inside SVG. But test thoroughly: `foreignObject` has quirks with `overflow: visible`, nested stacking contexts, and inconsistent behavior in WebKit (Tauri's macOS WebView via WKWebView).
4. If going full SVG for pills, accept that hover-expand needs a completely different implementation — likely a separate HTML tooltip/popover triggered by SVG mouse events.
5. Use Canvas `measureText()` for pill width measurement (synchronous, sub-ms, no DOM insertion) rather than `getBBox()`.

**Detection:**
- Ref pill text cut off without ellipsis
- "+N" hover expansion stops working
- `getBBox()` calls appear in hot paths
- Hover behavior breaks on ref pills

**Phase to address:**
This must be one of the LAST phases. Get bezier curves, overlay positioning, and interaction working first. Ref pills are the highest-risk SVG element due to HTML feature dependencies. Consider deferring to v0.6 if the migration proves too complex.

---

### Pitfall 6: TypeScript Transformation Layer Creates a Data Synchronization Bug Surface

**What goes wrong:**
The new TypeScript "Active Lanes" transformation layer sits between Rust output (`RawCommit[]`) and SVG rendering (`GraphData` with grid coordinates). When Rust data changes (commit, branch switch, fetch, loadMore), the TS layer must recompute in sync. If the TS layer's output gets stale, desynchronized, or partially updated, the SVG shows stale graph data overlaid on fresh commit rows.

**Why it happens:**
The current architecture is simple: Rust → `GraphCommit[]` → `computeGraphSvgData()` → per-row SVG. The TS transformation is a single function called via `$derived.by()` (CommitGraph.svelte line 267-269). But v0.5 adds a new intermediate layer with potentially more state:
- Grid coordinate mapping (x = swimlane, y = row index) 
- Edge routing decisions (where bezier control points go)
- Active lane tracking (which columns have continuous lines)
- Row-edge index (precomputed visibility lookup)

If any of these get out of sync with `displayItems` or if `$derived.by()` doesn't trigger on the right dependency, the overlay renders stale data.

**Consequences:**
- Graph lines point to wrong commit rows after refresh
- Stale paths visible for one frame during branch switch
- `loadMore()` appends commits but graph lines don't extend
- WIP row insertion shifts all rows down but graph lines don't shift

**Prevention:**
1. **Keep the transformation as a single pure function** — `computeGraphOverlay(displayItems, maxColumns) → GraphOverlayData`. No intermediate mutable state. Same pattern as current `computeGraphSvgData()`.
2. Wire via `$derived.by()` dependent on `displayItems` (which already wraps WIP and stash sentinels). This is the established project pattern.
3. Do NOT cache intermediate results across refreshes. The current approach recomputes from scratch on every data change — this is correct for consistency, and the computation is <10ms for 10k commits.
4. Add a sequence counter (existing `loadSeq` pattern) to guard against stale async if any part of the transformation becomes async.
5. Test: create commit → graph should update atomically. Branch switch → no stale lines visible. `loadMore()` → new paths appear seamlessly.

**Detection:**
- Graph lines point to wrong rows after `refresh()` 
- One-frame flash of stale graph data during branch switch
- `loadMore()` shows batch boundary gaps

**Phase to address:**
Phase 1 (data layer). Use the same reactive pattern as v0.4. The transformation layer should be stateless and deterministic.

---

## Moderate Pitfalls

---

### Pitfall 7: Per-Row SVG Path Duplication When Using ViewBox Clipping

**What goes wrong:**
If the implementation uses per-row `<svg>` with viewBox clipping (the v0.4 approach), each row renders ALL paths that intersect its Y band. A rail spanning 100 rows creates 100 identical `<path>` DOM nodes — one per visible row SVG. With 40 visible rows and 8 rails, that's 320 `<path>` elements that are identical copies. This is the OPPOSITE of the "single path" goal.

**Why it happens:**
The viewBox-clipped approach works visually but doesn't reduce DOM element count for continuous vertical rails. Each row's SVG must include every path passing through it. Rails pass through every row they span, so the path is duplicated in every row.

**Prevention:**
1. If staying with per-row viewBox clipping (hybrid approach from v0.4 ARCHITECTURE.md), accept the duplication as a tradeoff for simpler scroll sync.
2. If moving to a true single SVG overlay (v0.5 target), this pitfall is eliminated — each rail is one `<path>` element.
3. With the true overlay approach, use SVG virtualization (Pitfall 1) to keep element count bounded.
4. **Decision needed early:** Is v0.5 a true single SVG overlay or an enhanced viewBox-clipped model? PROJECT.md says "single SVG overlay" — commit to that and address Pitfalls 1-3 directly.

**Detection:**
- DevTools shows identical `<path>` elements duplicated across rows
- Total path count = (visible rows) × (active rails + passing edges)

**Phase to address:**
Phase 1 (architecture decision). Resolve this before building anything.

---

### Pitfall 8: Bezier Path `d` String Recomputation Causes GC Pressure

**What goes wrong:**
Every scroll event triggers SVG virtualization — culling paths outside the visible range and adding paths entering the visible range. If path `d` strings are recomputed on every scroll rather than cached, the constant string allocation and garbage collection causes GC pauses visible as micro-jank during smooth scrolling.

**Why it happens:**
SVG virtualization means the set of rendered paths changes on scroll. If the implementation regenerates `d` strings from grid coordinates on each scroll frame, it allocates new strings every frame. For 100 visible paths with 50-character `d` strings, that's 5KB of string allocation per frame × 60fps = 300KB/s of allocation → frequent minor GC pauses.

**Prevention:**
1. **Pre-compute all `d` strings once on data change, not on scroll.** Store them in the `GraphOverlayData` structure.
2. On scroll, only change WHICH pre-computed paths are included in the SVG — don't recompute the paths themselves.
3. Separate data-driven computation (path shapes) from scroll-driven computation (which paths to show):
   - Data change → recompute `GraphOverlayData` (all edges, all dots, all `d` strings)
   - Scroll change → filter `GraphOverlayData` by visible row range
4. Use the `rowEdgeIndex: Map<number, ContinuousEdge[]>` for O(1) visibility lookup.
5. Profile with DevTools → Performance → check for GC pauses during scroll.

**Detection:**
- Micro-jank during smooth scrolling that correlates with GC pauses in profiler
- "Scripting" time per frame >5ms during scroll
- High allocation rate visible in Memory timeline

**Phase to address:**
Phase 2 (path computation). Establish the compute-once-filter-on-scroll pattern from the start.

---

### Pitfall 9: Manhattan-to-Bezier Migration Breaks Edge Case Routing

**What goes wrong:**
The current Manhattan routing (`H + A + V` path segments) handles specific edge types differently: `MergeLeft`, `MergeRight`, `ForkLeft`, `ForkRight`. Each has different sweep directions for the arc. Replacing these with cubic beziers eliminates the edge-type-specific routing, but bezier curves don't inherently respect lane boundaries — a curve from column 2 to column 5 may visually pass through columns 3 and 4, potentially overlapping with other branch lines.

**Why it happens:**
Manhattan routing stays in its own column horizontally, then turns. Bezier curves interpolate smoothly and may bulge into neighboring columns. With 12-16px lane widths, a bezier from column 0 to column 4 may cross through columns 1, 2, and 3, visually overlapping with rail lines in those columns.

**Prevention:**
1. **Accept controlled overlap** — GitKraken's bezier curves also cross columns, and it looks fine because the curves use distinct colors per branch.
2. Ensure z-ordering is correct: rails (background) → edges (foreground) → dots (topmost). Use `<g>` groups.
3. Consider a "waterfall" approach where the curve goes vertical for a portion, then transitions. This is `M → V (small) → C → V (small)` rather than a single `C` command.
4. Test with repos that have many parallel branches (>5 columns) and frequent cross-column merges. The visual density may reveal overlap issues not visible with 2-3 branches.
5. If overlap is visually problematic, add a slightly larger `stroke-width` or a `stroke` background (e.g., a slightly wider background-colored stroke behind the colored one) to create visual separation.

**Detection:**
- Bezier curves visually cross through unrelated branch rail lines
- Graph becomes hard to read with 5+ parallel branches
- Colors blend where curves overlap rails

**Phase to address:**
Phase 2 (bezier computation). Requires visual testing with complex repos.

---

### Pitfall 10: WebKit SVG Performance Differs From Development Testing

**What goes wrong:**
The graph scrolls smoothly during development in `cargo tauri dev` but jank appears in the production Tauri app. On macOS, Tauri 2 uses WKWebView (WebKit), not Chromium. WebKit has different SVG rendering characteristics — particularly for large numbers of path elements and complex `d` strings with bezier commands.

**Why it happens:**
Developers test in `cargo tauri dev` which uses the system WebView but under dev-mode conditions. Production builds may behave differently. WebKit's SVG rendering pipeline has historically been less optimized than Blink's for programmatically-generated SVGs with many small elements.

Additionally, cubic bezier paths (`C` command) are more computationally expensive to rasterize than Manhattan paths (`H`, `V`, `A` with simple geometry). Each bezier requires curve subdivision and anti-aliasing per frame.

**Prevention:**
1. Test in production build (`cargo tauri build`) at every phase milestone.
2. Profile with Safari's Web Inspector: Develop → Device → Trunk → Timelines.
3. Avoid SVG features known to perform poorly in WebKit: filters, masks, clip-paths on many elements, complex gradients.
4. Prefer simple stroked `<path>` and `<circle>` — these are fast in all engines.
5. Set performance budget: graph rendering must complete in <8ms per frame.
6. If WebKit bezier performance is problematic, consider reducing path precision (round coordinates to integers, avoid sub-pixel values).

**Detection:**
- Smooth in development, janky in production build
- Frame drops only visible in production
- "Paint" >8ms for SVG layer in Safari Web Inspector

**Phase to address:**
All phases. Test in production build at each milestone.

---

### Pitfall 11: Pagination Boundary Seams Persist With Bezier Curves

**What goes wrong:**
When `loadMore()` fetches the next batch of 200 commits, bezier curves spanning the batch boundary must connect seamlessly. If the transformation layer treats each batch independently, curves disconnect at commit 200/201, 400/401, etc.

**Why it happens:**
The current `computeGraphSvgData()` operates on the full `displayItems` array (all loaded batches concatenated). The same approach should work for v0.5. But with bezier curves, a subtle issue arises: when `loadMore()` appends new commits, every existing edge's bezier may need new control point calculations if the curve math depends on the total number of rows. Additionally, `maxColumns` may change when new commits reveal previously unseen branches.

**Prevention:**
1. Always generate paths from the full `commits` array (all loaded batches combined), not per-batch. The current pattern already does this (`CommitGraph.svelte` line 283: `commits.push(...response.commits)`).
2. When `loadMore()` fires, recompute ALL paths. Don't try incremental append until profiling shows full recomputation exceeds 16ms.
3. For active rails that continue beyond the last loaded commit, extend them to `displayItems.length * ROW_HEIGHT` (the current SVG coordinate space bottom). They'll naturally extend when more commits load.
4. Test by slowly scrolling past batch boundaries (commit 200, 400, 600). Check for visible gaps, color changes, or curve discontinuities.

**Detection:**
- Visible horizontal gap in lane lines at every 200th commit
- Lane colors change at batch boundaries
- Bezier curves appear as two disconnected segments at batch boundary

**Phase to address:**
Phase 2 (path computation). Verify with pagination in Phase 3 (integration).

---

## Minor Pitfalls

---

### Pitfall 12: Svelte 5 `{#each}` Keying Causes Full SVG DOM Rebuild

**What goes wrong:**
Using array index as key in `{#each}` for SVG path elements causes Svelte to destroy and recreate all SVG DOM nodes when commits shift (new commit at top, `loadMore()` changes indices). Full rebuild causes visible flicker.

**Prevention:**
- Key SVG elements by stable identity: edges by `${childOid}->${parentOid}`, dots by commit OID, rails by column+color index.
- Use `{#each edges as edge (edge.id)}` pattern.
- Never key by array index for data that can shift.

**Phase to address:** Phase 3 (SVG rendering).

---

### Pitfall 13: Column Resize Desynchronizes SVG Width

**What goes wrong:**
When the user drags the graph column resize handle (`startColumnResize('graph', e)` — CommitGraph.svelte line 56), the SVG overlay width must update reactively. If the SVG width is calculated once and not bound to `columnWidths.graph`, the SVG extends beyond or falls short of the column boundary after resize.

**Prevention:**
- Bind SVG width reactively to `columnWidths.graph` or `maxColumns * LANE_WIDTH`.
- The current pattern already handles this (GraphCell.svelte line 17: `const svgWidth = $derived(...)`). The overlay approach must replicate this reactivity.
- Throttle path x-coordinate recalculation during resize drag — recalculate on mouseUp, not every mouseMove.

**Phase to address:** Phase 1 (foundation). Verify during integration.

---

### Pitfall 14: Connector Line Coordinate Mismatch Between HTML Ref Column and SVG Graph Column

**What goes wrong:**
The ref pill connector line (CommitRow.svelte line 55-57) currently uses HTML absolute positioning: it spans from `refContainerWidth` in the ref column to `commit.column * LANE_WIDTH + LANE_WIDTH / 2` in the graph column. If ref pills stay as HTML but the graph rendering moves to a single SVG overlay, the connector line endpoint coordinates are in different coordinate spaces — HTML pixels for the start, SVG user units for the end.

**Prevention:**
- If ref pills stay HTML: the connector line should ALSO stay HTML (current approach works fine).
- If ref pills move to SVG: the connector becomes an SVG `<line>` or `<path>` element within the overlay, with both endpoints in SVG coordinates.
- Do NOT try to draw an SVG line that terminates at an HTML element's position — coordinate translation between HTML and SVG is fragile, especially with column resizing.

**Phase to address:** Ref pill migration phase (one of the last phases).

---

### Pitfall 15: `$derived.by()` Recomputation Scope Too Broad

**What goes wrong:**
The `graphOverlayData = $derived.by(() => computeGraphOverlay(displayItems, maxColumns))` recomputation triggers on ANY change to `displayItems` — including hover state changes, selection changes, or ref pill expansion. If any reactive state touched by `displayItems` changes frequently, path recomputation fires unnecessarily.

**Why it happens:**
`displayItems` is currently a `$derived.by()` that depends on `commits`, `wipCount`, and `wipMessage` (CommitGraph.svelte line 254-265). If future phases add reactive state (e.g., selected commit, hovered branch) that feeds into `displayItems` or is accessed in the same derivation scope, the path computation triggers on interaction events.

**Prevention:**
- Keep `displayItems` derivation minimal: only `commits`, `wipCount`, `wipMessage`.
- DO NOT add selection/hover state to the same derivation chain.
- Selection highlighting and hover effects should be handled via CSS classes on HTML rows or SVG element attributes, not by recomputing path data.
- If partial recomputation is needed (e.g., highlighting one edge), use a separate reactive variable for highlight state, not a full path recompute.

**Phase to address:** Phase 1 (data layer). Establish the reactivity boundaries early.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Overlay container setup | Scroll sync drift (P2), pointer events (P3) | Prove scroll alignment + click pass-through before rendering any paths |
| TS transformation layer | Data sync bugs (P6), stale derivation (P15) | Single pure function via `$derived.by()`, no intermediate mutable state |
| Bezier path computation | Ugly adjacent-row curves (P4), lane overlap (P9) | Per-distance tension tuning, visual testbed with real repos |
| SVG virtualization | DOM explosion (P1), GC pressure (P8) | Compute-once + filter-on-scroll, hard 500-element limit |
| Ref pill migration | HTML capability loss (P5) | Defer to last phase, HTML fallback ready, `foreignObject` escape hatch |
| Interaction preservation | Pointer events swallowed (P3) | `pointer-events: none` on SVG root, all interactive targets on HTML rows |
| Dimension tuning | Bezier aesthetics (P4), WebKit perf (P10) | Test in production build, visual comparison with GitKraken |
| Pagination integration | Batch boundary seams (P11), path recomputation scope (P15) | Full-array recomputation, slow-scroll test past batch boundaries |

---

## "Looks Done But Isn't" Checklist

- [ ] **SVG element count:** Profile with 10k loaded commits — SVG child count stays under 500 regardless of total
- [ ] **Scroll sync at speed:** Verify alignment at extreme trackpad flick speeds, not just gentle mouse wheel
- [ ] **Sub-pixel alignment:** On Retina displays (2x DPI), verify SVG paths render crisply — no fuzzy 0.5px misalignment
- [ ] **Adjacent-row bezier:** Merge edge between row N and row N+1 looks smooth, not kinked
- [ ] **Distant-row bezier:** Merge edge spanning 10+ rows doesn't look wildly different from adjacent-row curves
- [ ] **Bottom boundary:** When scrolled to last commit, lane lines end at dot, not past it into empty space
- [ ] **Top boundary:** When WIP row present, dashed connector from WIP to HEAD renders correctly
- [ ] **Column resize:** Graph SVG width updates when user drags graph column resize handle
- [ ] **Column hide/show:** Hiding graph column hides SVG; showing restores without flash
- [ ] **Pagination boundary:** `loadMore()` at commit 200/201 — no visible seam, no color change
- [ ] **Branch switch:** After `refresh()`, SVG reflects new graph without stale paths from previous branch
- [ ] **Empty state:** Repo with 0 commits renders no broken SVG overlay
- [ ] **Single commit:** Repo with 1 commit renders single dot, no dangling lines
- [ ] **Stash rows:** `__stash_N__` sentinels render with dashed lines and correct dots
- [ ] **Context menu:** Right-click on commit row within graph column triggers `showCommitContextMenu`
- [ ] **Row click in graph area:** Clicking graph area of commit row fires `oncommitselect`
- [ ] **WIP row click:** Clicking WIP row in graph area fires `onWipClick`
- [ ] **Row hover:** `hover:bg-[var(--color-surface)]` visible when hovering over graph column area
- [ ] **Ref pill connector:** Connector line from ref pill to commit dot renders correctly
- [ ] **maxColumns change:** When `maxColumns` changes after `refresh()` or `loadMore()`, SVG adjusts
- [ ] **Production build:** Test in `cargo tauri build` on macOS — smooth 60fps scroll with 5k commits
- [ ] **Ref pill hover expand:** "+N" badge with hover-to-expand animation works (if migrated to SVG)
- [ ] **Visual parity → improvement:** Graph looks BETTER than v0.4 (bezier curves), not just different

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| DOM explosion (P1) | MEDIUM | Add viewport-based path culling; path generation logic stays the same, add visibility filter before rendering |
| Scroll sync (P2) | HIGH | If overlay approach fails entirely, fall back to v0.4's per-row viewBox clipping with bezier paths — this always works but loses the "single SVG" benefit |
| Pointer events (P3) | LOW | Add `pointer-events: none` to SVG root — 5-minute fix |
| Bezier aesthetics (P4) | MEDIUM | Tune control point formula; worst case, fall back to Manhattan routing for adjacent rows only |
| Ref pills as SVG (P5) | HIGH | Must rewrite back to HTML or `foreignObject`; the text layout differences cascade through hover, overflow, connector positioning. **Have the HTML fallback ready from the start.** |
| Data sync bugs (P6) | LOW | Ensure single pure function pattern; add defensive `console.assert` checks for data consistency |
| Path duplication (P7) | N/A | Only applies if using per-row viewBox clipping (v0.4 approach); eliminated by true overlay |
| GC pressure (P8) | LOW | Pre-compute `d` strings; filter on scroll not recompute on scroll |
| Lane overlap (P9) | LOW | Visual issue only; adjust stroke-width or add background stroke for separation |
| WebKit perf (P10) | MEDIUM-HIGH | Requires profiling and potentially simplifying SVG output; may need path precision reduction or partial canvas fallback for extreme cases |
| Pagination seams (P11) | LOW | Switch to full-array path generation; seams disappear immediately |

---

## The v0.4 Reversal Risk

The most important meta-pitfall: **v0.5 is reversing a deliberate v0.4 decision.** The v0.4 REQUIREMENTS.md (line 77) explicitly lists "Full-height single SVG (not clipped per row)" as **out of scope**, citing "Research showed DOM explosion at scale."

The v0.4 per-row viewBox approach works and ships. v0.5 is betting that SVG virtualization solves the DOM explosion concern. If that bet fails:

**Graceful fallback:** Keep bezier curves and dimension tuning (these work regardless of overlay approach). Revert to per-row viewBox clipping. The `computeGraphOverlay()` function and its bezier path computation are reusable — only the rendering layer changes. Loss: ~1-2 phases of overlay/scroll-sync work. Gain: proven architecture.

**Decision gate:** After Phase 1 (overlay container + scroll sync), measure:
1. Does SVG virtualization keep element count under 500?
2. Does scroll alignment stay pixel-perfect at trackpad-flick speeds?
3. Do all pointer events pass through correctly?

If any answer is NO, stop and evaluate whether to continue with the overlay or revert to enhanced per-row viewBox.

---

## Sources

### HIGH confidence (direct codebase analysis)
- `CommitGraph.svelte` — virtual list integration, pagination, refresh, reactive derivation pattern
- `CommitRow.svelte` — 6-column layout, ref pill HTML markup, connector line positioning, pointer events
- `GraphCell.svelte` — per-row viewBox-clipped SVG rendering, path filtering, dot rendering
- `graph-svg-data.ts` — current path computation (Manhattan routing, sentinel handling)
- `graph-constants.ts` — LANE_WIDTH=12, ROW_HEIGHT=26, DOT_RADIUS=6
- `types.ts` — GraphCommit, GraphEdge, EdgeType, SvgPathData data model
- `.planning/research/ARCHITECTURE.md` — v0.4 overlay vs viewBox decision, virtual list DOM structure
- `.planning/research/STACK.md` — virtual list API surface, SVG performance analysis
- `.planning/RETROSPECTIVE.md` — "visual rendering is the riskiest area" across all milestones

### MEDIUM confidence (web standards, established knowledge)
- [MDN SVG Paths](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths) — cubic bezier `C` command specification, control point semantics
- [MDN SVG pointer-events](https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/pointer-events) — `none`/`auto`/`visiblePainted` values for SVG elements
- [SVG Performance — O'Reilly Using SVG](https://oreillymedia.github.io/Using_SVG/extras/ch19-performance.html) — layout cost, viewBox implications, DOM node count thresholds
- [Git Extensions Revision Graph Wiki](https://github.com/gitextensions/gitextensions/wiki/Revision-Graph) — per-row grid rendering approach in established Git GUI

### LOW confidence (training data, unverified claims)
- WebKit SVG bezier rasterization cost relative to Blink — training data only, no verified benchmark. Flagged as requiring empirical profiling (see Pitfall 10).
- GitKraken curve rendering specifics — closed source, observed externally only. Piecewise "waterfall" routing is an inference, not confirmed.

---

*Pitfalls research for: Trunk v0.5 — Single SVG overlay with cubic bezier curves*
*Researched: 2026-03-13*
