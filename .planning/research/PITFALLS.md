# Pitfalls Research

**Domain:** Full-height SVG graph overlay in virtualized commit list (Tauri 2 + Svelte 5 desktop Git GUI)
**Researched:** 2026-03-12
**Confidence:** HIGH (based on codebase analysis of CommitGraph/CommitRow/LaneSvg + established SVG/DOM performance knowledge)

---

## Critical Pitfalls

---

### Pitfall 1: Full-Height SVG DOM Explodes With Large Repositories

**What goes wrong:**
A single SVG element containing one `<path>` per branch lane and one `<path>` per merge/fork edge for all loaded commits creates a massive DOM subtree. With 8 active lanes and frequent merges across 10,000 commits (the current batch-loaded amount), the SVG could contain 50,000+ child elements. Browser layout/paint slows to single-digit FPS, memory usage spikes, and style recalculation blocks the main thread for >16ms per frame.

**Why it happens:**
The current per-row `LaneSvg.svelte` approach naturally virtualizes: `@humanspeak/svelte-virtual-list` keeps only ~40 rows in the DOM. Each row has a small SVG with 3-10 elements. Switching to a full-height SVG means the SVG itself is NOT virtualized. Developers assume "paths are lightweight" but each `<path>` is a full DOM node with style computation, bounding box calculation, and hit-testing surface. The current paginated loading (`BATCH = 200`, `loadMore()`) compounds this -- every batch appends more paths to the same SVG, and the DOM only grows.

**How to avoid:**
1. Do NOT render paths for the entire commit history. The SVG should only contain paths for the visible window plus a buffer (similar to how the virtual list works for HTML rows).
2. Compute which lane segments and edges intersect the visible viewport (based on `scrollTop` and viewport height) and only emit `<path>` elements for those. This is "SVG virtualization."
3. Size the SVG to match the virtual list's total content height (so it scrolls naturally), but populate it with only the visible subset of paths.
4. When `loadMore()` appends commits, do NOT append paths -- recalculate the visible window and render only what's in view.
5. Use a buffer of 2-3 viewport heights above and below to prevent path pop-in during fast scrolling.

**Warning signs:**
- DevTools Elements panel shows an SVG with 10,000+ children
- Jank increases linearly as the user scrolls down and triggers more `loadMore()` calls
- Memory usage grows without bound as commits load (should plateau at buffer size)
- Profiler shows "Recalculate Style" or "Layout" taking >16ms in the SVG subtree

**Phase to address:**
Phase 1 (foundation). The SVG container sizing and path virtualization strategy must be decided before any path rendering. Getting this wrong means rewriting the entire overlay approach.

---

### Pitfall 2: Scroll Synchronization Drift Between SVG Overlay and HTML Rows

**What goes wrong:**
The SVG overlay and the virtual list's scroll container fall out of sync. Lane lines do not align with their corresponding commit rows. Symptoms: (a) visual offset that grows as you scroll, (b) sub-pixel jitter during fast scroll, (c) snap-to-wrong-position after scroll momentum ends on trackpad.

**Why it happens:**
`@humanspeak/svelte-virtual-list` manages its own scroll container. If the SVG is positioned as a separate absolutely-positioned element outside this container, synchronization requires reading `scrollTop` from the list container and applying it to the SVG. Problems:
- Scroll events fire asynchronously -- by the time the SVG transform updates, the list has already painted at the new position, causing a one-frame lag.
- The virtual list may use CSS `transform: translateY()` internally to position visible items rather than true scroll offset, creating a mismatch.
- Sub-pixel rounding differs between CSS transform values and SVG coordinate systems, causing 0.5-1px cumulative drift.
- `requestAnimationFrame` throttling means the SVG update lags behind the native scroll repaint.

**How to avoid:**
1. Place the SVG INSIDE the virtual list's scroll container as a positioned sibling of the row content. This way it scrolls with the same native scrollTop -- zero synchronization code needed.
2. Set the SVG to `position: absolute; top: 0; left: 0` within the scrollable area, with height equal to total content height (`commits.length * ROW_HEIGHT`). The browser handles sync natively.
3. If the virtual list library does not expose its scroll container for child injection, wrap both the list and the SVG in a shared scroll container and disable the list's own scrolling.
4. AVOID any approach that reads `scrollTop` from one element and writes it to another. This always produces visible lag.

**Warning signs:**
- Any code that reads `scrollTop` from one element and applies it to another via JS
- Graph lines misalign with commit dots by 1-2px after fast trackpad scroll
- Visible "snap" correction when scroll momentum ends
- Lines align correctly after a brief delay (one-frame lag)

**Phase to address:**
Phase 1 (foundation). The overlay positioning strategy is the single most important architectural decision.

---

### Pitfall 3: Pointer Events Swallowed by SVG Overlay, Breaking Row Interactions

**What goes wrong:**
The full-height SVG sits on top of the HTML commit rows in the graph column. Click, hover, and context-menu events on rows stop working because the SVG intercepts them. The current right-click context menu (Copy SHA, Checkout, Cherry-pick, Revert, Reset, etc.) silently breaks. Row hover highlighting disappears. Commit selection on click stops working within the graph column area.

**Why it happens:**
A positioned SVG element creates its own stacking context. When it overlaps HTML elements, it captures all pointer events by default. The naive fix (`pointer-events: none` on the SVG root) disables ALL SVG interaction -- but the v0.4 spec says commit dots should remain clickable (they are currently clickable via the row's HTML `onclick` handler, but moving them to SVG changes the event target).

**How to avoid:**
1. Set `pointer-events: none` on the root `<svg>` element. This makes the entire SVG transparent to clicks by default.
2. Set `pointer-events: auto` (or `visiblePainted`) ONLY on specific interactive SVG children (commit dots, ref pills if they become SVG elements).
3. Scope the SVG overlay to cover ONLY the graph column width (`columnWidths.graph` pixels), not the full row width. This limits the conflict zone -- message, author, date, and SHA columns remain unaffected.
4. Test all existing interactions after adding the overlay: row click (`oncommitselect`), row hover highlight, right-click context menu (`showCommitContextMenu`), WIP row click (`onWipClick`).
5. Consider keeping the click target on the HTML row and making the SVG entirely non-interactive. The commit dot in SVG is visual-only; the HTML row is the interactive element. This is the simplest correct approach.

**Warning signs:**
- Commit rows stop responding to click/hover after SVG overlay is added
- Context menu stops appearing on right-click within the graph column
- Row hover background (`hover:bg-[var(--color-surface)]`) disappears in the graph area
- Selection works only when clicking on message/author/date columns, not the graph area

**Phase to address:**
Phase 1 (foundation), re-verified at every subsequent phase. Every new SVG element must be tested for pointer-event pass-through.

---

### Pitfall 4: SVG Re-Render Storm on Data Changes

**What goes wrong:**
When the commit list refreshes (new commit, branch switch, fetch, filesystem watcher fires), the entire SVG re-renders. The current `refresh()` method replaces the entire `commits` array atomically (`commits = response.commits`). For the HTML virtual list this is fine -- only visible rows re-render. But for a full-height SVG, Svelte's reactivity sees every path's `d` attribute as potentially changed. If the data shape changes (new commit inserted at top), EVERY path's Y coordinates shift, triggering a full SVG DOM teardown and rebuild.

**Why it happens:**
Svelte 5's fine-grained reactivity (`$derived`) will recompute path `d` strings when the underlying commit data changes. Path `d` strings are long (e.g., `M 6 13 V 0` for a simple segment, but `M 6 13 H 30 A 6 6 0 0 1 36 19 V 26` for merge edges). Svelte diffs these string-by-string. When a new commit is inserted at the top, every commit shifts down by `ROW_HEIGHT`, changing every Y coordinate in every path string. Result: 100% of paths are "changed" even though the visual structure is identical -- just shifted.

**How to avoid:**
1. Use keyed `{#each}` blocks for SVG path elements. Key lane paths by lane identifier (column + color_index combination) so Svelte reuses DOM nodes for lanes that persist across refreshes.
2. Separate the "what lane exists" data from "where it is positioned." Compute lane identity (which lanes, what colors, what merge connections) separately from lane position (Y coordinates). Only recompute positions when scroll changes; only recompute identity when commit data changes.
3. For the "new commit at top" case: consider shifting the SVG `viewBox` by `ROW_HEIGHT` instead of recalculating all path coordinates. The paths stay identical; only the viewport moves.
4. Debounce SVG path recalculation. The filesystem watcher already debounces at 300ms in Rust, but the frontend should also batch updates -- do not recalculate paths on every `refreshSignal` increment within the same rAF frame.
5. Profile with DevTools Performance panel: if "Scripting" time during refresh exceeds 5ms, the path computation needs optimization (possibly move to Rust and send `d` strings via IPC).

**Warning signs:**
- Visible flicker when creating a commit or switching branches
- DevTools Performance panel shows long "Scripting" blocks during graph refresh
- `$derived` computations for path `d` strings taking >5ms
- Entire SVG disappears and reappears (full teardown/rebuild instead of DOM update)
- Scroll position jumps after refresh because SVG height changed

**Phase to address:**
Phase 2 (branch line paths) for initial implementation. Re-validated when merge/fork edges are added (Phase 3) and when ref pills are added (Phase 4+).

---

### Pitfall 5: Ref Pills as SVG Elements Lose HTML Layout Capabilities

**What goes wrong:**
Moving ref pills from HTML to SVG breaks text rendering, overflow handling, and the current hover-expand behavior. The existing ref pill system in `CommitRow.svelte` is deeply HTML-dependent:
- First pill + "+N" overflow badge with `overflow: hidden` on the container
- Hover-to-expand overlay with `clip-path` CSS animation (`inset(0 100% 100% 0)` to `inset(0 0% 0% 0)`)
- `bind:clientWidth={refContainerWidth}` for connector line positioning
- Tailwind classes for sizing, colors, and hover states

SVG `<text>` has no `text-overflow: ellipsis`, no `overflow: hidden`, no CSS flexbox, no `clientWidth` binding.

**Why it happens:**
SVG text rendering is fundamentally different from HTML. SVG has no box model -- `<text>` elements have no width, no padding, no overflow behavior. Developers discover this after attempting the migration, when all the edge cases surface: multi-ref rows, long branch names, hover-expand behavior, and per-pill color backgrounds.

**How to avoid:**
1. Keep ref pills as HTML elements. The ref column is already a separate column from the graph column in the current 6-column layout. Ref pills do not NEED to be inside the SVG.
2. Only the connector line (from ref pill to commit dot) needs to cross the column boundary. This connector can be an SVG element within the graph SVG, or a simple CSS pseudo-element / absolutely-positioned `<div>`.
3. If the project spec requires ref pills to be SVG (it does say "Ref pills: SVG elements"), use `<foreignObject>` to embed the existing HTML pill markup inside the SVG. But test thoroughly: `foreignObject` has quirks with `overflow: visible`, nested stacking contexts, and inconsistent behavior in WebKit (Tauri's macOS WebView).
4. If going full SVG for pills, accept that the hover-expand behavior needs a completely different implementation -- likely a separate HTML tooltip/popover triggered by SVG mouse events rather than CSS-only animation.

**Warning signs:**
- Ref pill text cut off without ellipsis indicator
- "+N" hover expansion stops working
- Ref pills render at wrong size at different DPI/zoom levels
- `bind:clientWidth` equivalent does not exist for SVG elements (must use `getBBox()` which triggers synchronous layout)
- Lane-colored backgrounds look different between SVG `<rect>` fill and CSS `background`

**Phase to address:**
This should be one of the LAST phases. Get branch lines, merge edges, and commit dots working first. Ref pills are the highest-risk SVG element due to the HTML feature dependencies.

---

### Pitfall 6: Pagination Boundary Seams -- Path Segments Disconnect at Batch Edges

**What goes wrong:**
When `loadMore()` fetches the next batch of 200 commits, new path segments must connect seamlessly to existing paths. If the path generation treats each batch independently, there is a visible gap or misalignment at the batch boundary (commit 200-201, 400-401, etc.). Lane lines appear to end abruptly and restart.

**Why it happens:**
The current per-row `LaneSvg.svelte` avoids this because each row renders its own self-contained SVG -- edges connect to row boundaries (y=0 at top, y=ROW_HEIGHT at bottom). With full-height paths, a lane line that spans commits 150-250 must be a single continuous path, but commit 150 was in batch 1 and commit 250 is in batch 2. If paths are generated per-batch, the lane line becomes two separate `<path>` elements with a visible seam.

**How to avoid:**
1. Generate paths from the full `commits` array (all loaded batches combined), not per-batch. The `commits` array in `CommitGraph.svelte` is already a single concatenated array (`commits.push(...response.commits)`).
2. When a new batch loads, regenerate affected paths that span the batch boundary. This means the "last few" paths from the previous batch need to extend into the new batch's territory.
3. Since the SVG is virtualized (Pitfall 1), only paths intersecting the visible window are rendered anyway. The batch boundary is irrelevant to what's in the DOM -- it only matters for path data computation, which should operate on the full commit list.
4. For lanes that continue beyond the last loaded commit (the lane goes deeper into history but those commits haven't loaded yet), extend the lane path to the bottom edge of the SVG. When more commits load, the path will naturally extend further.

**Warning signs:**
- Visible horizontal gap in lane lines at every 200th commit
- Lane colors change at batch boundaries (path element gets wrong `color_index`)
- Merge edges that cross batch boundaries render as two disconnected segments
- Scrolling slowly past a batch boundary shows paths "popping in" instead of being already connected

**Phase to address:**
Phase 2 (branch line paths). Must be verified when merge/fork edges span batch boundaries (Phase 3).

---

### Pitfall 7: Accessibility Regression From Moving Interactive Elements Into SVG

**What goes wrong:**
The current HTML commit rows are naturally part of the document flow -- screen readers can traverse them, keyboard focus works on the `<div>` elements, and the existing `onclick` and `oncontextmenu` handlers are standard DOM events. Moving commit dots and potentially ref pills into SVG breaks keyboard navigation, focus management, and screen reader announcements. SVG elements are not in the tab order by default and have limited ARIA support across browsers.

**Why it happens:**
SVG accessibility is an afterthought. Developers verify visual correctness and click behavior but forget that SVG elements need explicit `role`, `aria-label`, and `tabindex` attributes. Focus indicators (outlines) do not render correctly on SVG circles. Screen readers may skip SVG content entirely.

**How to avoid:**
1. Keep all interactive targets on HTML elements. The commit row click handler (`onclick={() => onselect?.(commit.oid)}`) should remain on the HTML `<div>`, not move to the SVG commit dot.
2. Mark the SVG graph as decorative: `<svg role="img" aria-hidden="true">`. Screen reader users get commit info from the HTML row text, not the visual graph.
3. Do NOT add `tabindex` to SVG elements. Keyboard navigation should operate on the HTML rows (the existing `<div>` structure).
4. The SVG graph is a visual representation of data that is already accessible via the commit message, author, date, and SHA columns. It does not need independent accessibility.

**Warning signs:**
- Tab key stops moving through commit list after SVG changes
- Screen reader announces "image" or nothing for the graph area instead of commit data
- Focus outline appears on SVG circles instead of HTML rows

**Phase to address:**
Phase 1 (foundation). Decide the accessibility model upfront: SVG is decorative, HTML rows are interactive. Verify with keyboard-only navigation at each subsequent phase.

---

### Pitfall 8: WebKit SVG Performance Differs From Chrome/Blink

**What goes wrong:**
Development happens in `cargo tauri dev` which may use a different rendering engine than the production Tauri app. On macOS, Tauri 2 uses WKWebView (WebKit), not Chromium. WebKit has historically had different (often worse) SVG rendering performance characteristics -- particularly for large numbers of path elements, complex path `d` strings, and SVG filter effects. A graph that scrolls smoothly in Chrome DevTools may jank in the actual Tauri app.

**Why it happens:**
Developers test in the browser (often Chrome) during development, or in `cargo tauri dev` which uses the system WebView but under dev-mode conditions (V8 JIT not fully optimized, dev tools attached). Production performance on macOS WebKit can differ substantially, especially for SVG-heavy content.

**How to avoid:**
1. Test frequently in a production build (`cargo tauri build`), not just `cargo tauri dev`.
2. Profile in WebKit specifically. On macOS, use Safari's Web Inspector to profile the Tauri WebView (Develop > Device > Trunk).
3. Avoid SVG features known to perform poorly in WebKit: filters (`feGaussianBlur`, `feDropShadow`), masks, clip-paths on many elements, complex gradients.
4. Prefer simple stroked `<path>` and `<circle>` elements -- these are fast in all engines.
5. Set a performance budget: graph rendering (paths in viewport) must complete in <8ms (half a frame at 60fps) to leave room for HTML row rendering.

**Warning signs:**
- Smooth in browser, janky in Tauri app
- "Slow Script" warnings in WebKit Web Inspector
- Frame drops only on production builds, not dev builds
- Profiler shows "Paint" taking >8ms for the SVG layer alone

**Phase to address:**
All phases. Test in production build at each milestone, not just at the end.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Rendering all paths without SVG virtualization | Simpler code, no windowing logic | Unusable on repos >5k commits; DOM grows without bound | Never for production. OK for proof-of-concept with <500 commits only |
| Syncing scroll via JS scroll event listener | Works without modifying virtual list internals | One-frame lag jitter, additional code to maintain | Only if SVG cannot be placed inside the scroll container |
| Using `foreignObject` for ref pills | Reuses existing HTML pill markup entirely | Cross-engine quirks, stacking context issues, extra complexity | Acceptable as v0.4 approach if full SVG pills are deferred |
| One giant `<path>` per lane for entire loaded history | Simple path generation, single DOM node per lane | Cannot virtualize; path `d` string grows unbounded; recomputation cost grows linearly | Acceptable for repos <2k commits if path recomputation is memoized |
| Hardcoding SVG dimensions instead of deriving from data | Quick to implement | Breaks on column resize, different DPI, and when `maxColumns` changes | Never -- derive from `maxColumns * LANE_WIDTH` and total content height |
| Computing path `d` strings in Svelte `$derived` | Reactive, auto-updates on data change | String allocation churn on every scroll position change; GC pressure | Acceptable if paths are memoized and only recomputed on data change (not scroll) |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `@humanspeak/svelte-virtual-list` + SVG overlay | Placing SVG as a sibling outside the virtual list component | Place SVG inside the virtual list's scroll container (may require forking/wrapping the library), or wrap both in a shared scroll parent |
| Svelte 5 `$derived` + SVG path `d` attributes | Using `$derived` for long path strings on scroll change triggers excessive string diffing | Compute path strings only on data change (commit array mutation), not on scroll. Use memoization keyed by commit data identity |
| Svelte 5 `{#each}` keying + SVG elements | Using array index as key causes full DOM rebuild when commits shift | Key SVG lane elements by lane identity (column + color_index), not array position |
| Tauri WKWebView + large SVG | Assuming WebView SVG perf matches Chrome | Test on production build; profile with Safari Web Inspector; WebKit is stricter about layout thrashing |
| Paginated `loadMore()` + continuous paths | Path generation treats batches independently, creating seams | Generate paths from full `commits[]` array; virtualize rendering separately from data |
| Column resize (`startColumnResize`) + SVG width | SVG width not updating when user drags the graph column resize handle | Bind SVG width reactively to `columnWidths.graph`; recalculate path X coordinates on resize |
| WIP sentinel (`__wip__`) + SVG paths | WIP row gets standard straight-edge path instead of dashed connector | Handle `__wip__` explicitly in path generation: dashed stroke, start from WIP circle to HEAD position |
| Stash sentinel (`__stash_N__`) + SVG dots | Stash rows get round dots instead of square dots | Handle stash sentinels in the dot rendering layer: use `<rect>` instead of `<circle>` |
| `displayItems` reactive array + SVG | SVG path computation based on `displayItems` (includes WIP) but data refresh only replaces `commits` | Either recompute paths from `displayItems` (includes WIP row) or handle WIP position separately from main path data |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unvirtualized SVG with all loaded paths | Jank increases linearly as more commits load via `loadMore()` | Render only paths intersecting visible viewport + 2-screen buffer | >2,000 loaded commits (~500 visible DOM paths is the safe limit) |
| SVG style recalculation cascade | "Recalculate Style" >16ms in profiler on scroll | Use CSS classes on SVG elements (not inline `style`); minimize total SVG child count | >500 SVG elements with inline styles |
| Reactive path recomputation on every scroll frame | `$derived` path data fires on scroll position change | Separate scroll-driven rendering (which paths to show) from data-driven computation (path shapes). Only recompute "which paths" on scroll; only recompute "path shapes" on data change | Continuous scrolling on any repo |
| `getBBox()` calls for interactive hit-testing | Synchronous layout thrashing (forced reflow) on every mouse move | Cache bounding boxes; recompute only on data change, never during event handlers | >100 interactive SVG elements |
| SVG filter effects on lanes | GPU memory spike, paint time explosion per frame | Do not use SVG filters. Simple stroke colors are sufficient (existing palette works well) | Any scale -- filters are expensive even with 10 elements |
| Path `d` string GC churn | High GC pause frequency in profiler | Pre-allocate path string builders; cache computed `d` strings keyed by lane identity; reuse when unchanged | >50 paths recomputed per frame |
| Full `commits[]` array scan for path generation | O(n) per frame where n = total loaded commits | Only scan commits in the visible window for rendering; precompute lane index per commit for O(1) lookup | >5,000 loaded commits |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Lane lines disappear during very fast scroll | User loses branch context during navigation | Keep path buffer large enough (3x viewport) to prevent pop-in; accept that extreme scroll speeds may show brief gaps |
| Connector lines (ref pill to dot) misalign during column resize | Visual glitch breaks trust in the tool | Recalculate connector endpoints reactively when `columnWidths` changes; the current connector line in `CommitRow.svelte` (line 54) already does this for HTML |
| Hover state on SVG commit dot conflicts with HTML row hover | Confusing double-highlight: row background changes AND dot brightens | Keep hover behavior on the HTML row only; SVG dots do not respond to hover |
| Graph column resize causes all paths to redraw with visible flash | Jarring visual during interactive resize | Throttle path recalculation during resize drag (recompute on mouseUp, not every mouseMove) |
| Merge edge paths cross behind unrelated lane lines | Visual clutter makes graph unreadable | Maintain the existing three-layer z-order (rails -> edges -> dots) using SVG `<g>` groups within the SVG, preserving the `LaneSvg.svelte` rendering order |
| Visual regression: graph looks different after rework | Users notice any change; spec says "visuals stay identical" | Pixel-compare screenshots of the current graph vs. the new graph on the same repo at the same scroll position |

---

## "Looks Done But Isn't" Checklist

- [ ] **Scroll sync:** Verify alignment at extreme scroll speeds (trackpad flick), not just gentle mouse wheel scrolling
- [ ] **Sub-pixel alignment:** On Retina displays (2x DPI), verify SVG paths render crisply -- no fuzzy 0.5px misalignment between SVG coordinates and pixel grid
- [ ] **Bottom boundary:** When scrolled to the very last commit, lane lines end at the last commit's dot, not past it into empty space
- [ ] **Top boundary:** When WIP row is present, the dashed connector from WIP circle to HEAD dot renders correctly across the SVG/row boundary
- [ ] **Column resize:** Graph SVG width updates when user drags the graph column resize handle (`startColumnResize('graph', e)`)
- [ ] **Column hide/show:** Hiding the graph column (`columnVisibility.graph = false`) properly hides the SVG overlay; showing it restores without path flash
- [ ] **Pagination boundary:** When `loadMore()` appends 200 commits, paths connect seamlessly -- no visible seam at commit 200/201
- [ ] **Branch switch:** After `refresh()` replaces `commits` array, SVG reflects the new graph without stale paths from previous branch
- [ ] **Empty state:** Repo with 0 commits does not render a broken/orphaned SVG overlay
- [ ] **Single commit:** Repo with 1 commit renders a single dot, no dangling lane lines
- [ ] **Stash rows:** `__stash_N__` sentinel items render with square dots (current behavior: square dots in `LaneSvg`) in the new SVG model
- [ ] **Context menu:** Right-click on a commit row within the graph column still triggers `showCommitContextMenu` (Copy SHA, Checkout, Cherry-pick, etc.)
- [ ] **Row click in graph column:** Clicking on the graph area of a commit row still fires `oncommitselect`
- [ ] **WIP row click:** Clicking the WIP row in the graph area still fires `onWipClick`
- [ ] **Row hover:** Hover background (`hover:bg-[var(--color-surface)]`) still visible when hovering over the graph column area
- [ ] **Ref pill connector:** The connector line from ref pill to commit dot (currently `CommitRow.svelte` line 52-55) still renders correctly with the new SVG model
- [ ] **maxColumns change:** When `maxColumns` changes after `refresh()` or `loadMore()`, the SVG width adjusts and all paths reflow
- [ ] **Visual parity:** Side-by-side screenshot comparison with pre-rework graph shows identical visual output

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Full SVG without virtualization (P1) | MEDIUM | Add viewport-based path culling post-hoc; path generation logic stays the same, add visibility filter before rendering |
| Scroll sync via JS listener (P2) | LOW | Move SVG inside scroll container; delete listener code; no path logic changes needed |
| Pointer events blocking rows (P3) | LOW | Add `pointer-events: none` to SVG root + `pointer-events: auto` on interactive children; 5-minute fix |
| SVG re-render storm (P4) | MEDIUM | Add keying to `{#each}`, memoize path `d` strings, separate data-change from scroll-change reactivity |
| Ref pills as full SVG (P5) | HIGH | Must rewrite back to HTML or `foreignObject`; the text layout differences cascade through hover behavior, overflow, and connector positioning |
| Pagination boundary seams (P6) | LOW | Switch from per-batch to full-array path generation; seams disappear immediately |
| Accessibility regression (P7) | LOW | Mark SVG `aria-hidden="true"`, ensure HTML rows retain all interactive behavior; minimal code change |
| WebKit perf differences (P8) | MEDIUM | Requires profiling and potentially simplifying SVG output; may need to reduce path complexity or add canvas fallback |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| SVG DOM explosion (P1) | Phase 1: Foundation/Container | Profile with 10k commits loaded; SVG child count stays under 500 regardless of total |
| Scroll sync drift (P2) | Phase 1: Foundation/Container | Pixel-compare lane-to-dot alignment at scroll positions 0, middle, and bottom on fast trackpad flick |
| Pointer events (P3) | Phase 1: Foundation/Container | Click, hover, context-menu all work on rows within graph column; test every interaction from current CommitRow |
| Re-render storm (P4) | Phase 2: Branch line paths | Measure `refresh()` time with DevTools; SVG update <16ms for branch switch on 5k-commit repo |
| Ref pills as SVG (P5) | Phase 4+ (last) | Hover-expand works, text truncates with ellipsis, pill colors match HTML version exactly |
| Pagination seams (P6) | Phase 2: Branch line paths | Load 3 batches (600 commits); scroll slowly past batch boundaries; no visible seams |
| Accessibility (P7) | Phase 1: Foundation (ongoing) | Tab through commit list; screen reader announces commit message/author for every row |
| WebKit perf (P8) | All phases | Run `cargo tauri build` and test in production app at each phase; profile with Safari Web Inspector |

---

## Sources

- Codebase analysis: `CommitGraph.svelte` (virtual list integration, pagination, refresh), `CommitRow.svelte` (6-column layout, ref pill HTML, connector line, pointer events), `LaneSvg.svelte` (three-layer SVG rendering, edge paths, dot rendering), `graph-constants.ts` (dimensions)
- [Planning for Performance -- Using SVG (O'Reilly)](https://oreillymedia.github.io/Using_SVG/extras/ch19-performance.html) -- SVG layout cost, viewBox performance implications
- [Improving SVG Runtime Performance (CodePen)](https://codepen.io/tigt/post/improving-svg-rendering-performance) -- DOM node count thresholds, style recalculation costs
- [Managing SVG Interaction With Pointer Events (Smashing Magazine)](https://www.smashingmagazine.com/2018/05/svg-interaction-pointer-events-property/) -- pointer-events: none/auto pattern for overlays
- [SVG pointer-events attribute (MDN)](https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/pointer-events) -- per-element pointer-event control
- [Stacking context (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_positioned_layout/Understanding_z-index/Stacking_context) -- SVG/HTML stacking context isolation
- [Updating a DOM tree with 110k nodes (Medium)](https://mmomtchev.medium.com/updating-a-dom-tree-with-110k-nodes-while-scrolling-with-animated-svgs-88d962661405) -- large SVG DOM handling strategies
- [SVG Optimization for Web Performance (2026 Guide)](https://vectosolve.com/blog/svg-optimization-web-performance-2025) -- current best practices for SVG performance
- [Git Extensions Revision Graph Wiki](https://github.com/gitextensions/gitextensions/wiki/Revision-Graph) -- per-row grid rendering approach in established Git GUI

---

*Pitfalls research for: v0.4 Graph Rework -- full-height SVG overlay in virtualized commit list*
*Researched: 2026-03-12*
