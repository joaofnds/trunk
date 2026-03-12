# Feature Landscape

**Domain:** Full-height SVG overlay graph rendering for desktop Git GUI
**Researched:** 2026-03-12
**Confidence:** MEDIUM (rendering internals of commercial Git GUIs are not publicly documented; recommendations based on web standards, open-source implementations, and codebase analysis)

---

## Context

Trunk v0.3 renders the commit graph using per-row inline SVGs inside a virtual scrolling list. Each `CommitRow` contains a `LaneSvg` component that renders its own `<svg>` with three layers: rail lines (straight edges), merge/fork connection paths, and commit dots. This creates visual seam artifacts at row boundaries and fragments branch lines across hundreds of small SVG elements.

The v0.4 rework replaces per-row SVGs with full-height SVG elements where each branch line and merge edge is a single continuous `<path>`. The goal is architectural improvement with zero visible change.

**Current rendering elements (from `LaneSvg.svelte`):**
- Straight edges: `<line>` elements per row, one per lane passing through
- Merge/fork edges: `<path>` elements with Manhattan routing (H + A + V), clipped to single row height
- Commit dots: `<circle>` elements (solid, hollow-merge, dashed-WIP)
- WIP connector: dashed `<line>` spanning from WIP row into next row (uses `overflow: visible`)
- Stash dots: square dots via sentinel OIDs
- Ref pill connectors: HTML `<div>` with absolute positioning in `CommitRow.svelte`
- Ref pills: HTML elements (not SVG) in `RefPill.svelte`

---

## How Existing Git GUIs Handle Graph Rendering

| Tool | Technology | Graph Approach | Notes |
|------|-----------|---------------|-------|
| **GitKraken** | Electron (Chromium) | Continuous branch lines in a dedicated graph column | Closed-source. Lines clearly span full visible area as continuous elements. Supports hover-highlight of full branch flow. |
| **Sublime Merge** | Custom native + OpenGL | GPU-rendered continuous graph | Not web tech at all. Uses OpenGL for all rendering including text. Graph is painted as continuous geometry. |
| **Fork** | Native (Cocoa/WinForms) | Platform-native drawing (Core Graphics / Direct2D) | Continuous graph column. Not web-based. |
| **Gitea** | Server-rendered SVG (moved from Canvas) | Full-column SVG with 16-color palette, flow-based hover highlight | [PR #12333](https://github.com/go-gitea/gitea/pull/12333) switched from client Canvas to server SVG specifically to enable proper flow tracking. |
| **GitLG (VS Code)** | Vue.js + virtual scrolling | Graph column with configurable curve-radius, loads 15k commits | Virtual scroller renders efficiently. [Source](https://github.com/phil294/GitLG). |
| **git-branch-graph** | React + SVG + virtual scrolling | "SVG Optimization" for branch lines, virtual scrolling for visible commits | [Source](https://github.com/snailuu/git-branch-graph). |
| **Bitbucket (web)** | Segmented SVG blocks | Renders ~50 commits per SVG block, stitches together | Pragmatic approach for web; still has boundary management. [Discussed in gitgraph.js #215](https://github.com/nicoespeon/gitgraph.js/issues/215). |

**Key insight:** Every production-quality Git GUI renders branch lines as continuous elements, not per-row fragments. The per-row approach is a simplification that works for initial shipping but creates seam artifacts and prevents branch-flow interactions (hover, click).

---

## Table Stakes

Features that MUST work correctly in the new rendering model. Missing any = regression from v0.3.

| Feature | Why Expected | Complexity | Dependencies | Notes |
|---------|--------------|------------|--------------|-------|
| **Continuous vertical rail lines** | Core motivation for the rework. Each lane becomes one `<path>` spanning all loaded rows. | HIGH | Scroll sync infrastructure, lane data from Rust | Currently N separate `<line>` elements per lane across N rows. Must become 1 `<path>` per active lane. Path must know which rows the lane is active for (branch tip to last commit on that lane). |
| **Continuous merge/fork edges** | Eliminates row-boundary seam bugs for Manhattan-routed connections. | HIGH | Edge data from Rust, path coordinate system | Currently each merge/fork edge is clipped to one row's height via `buildEdgePath()`. Must now span from the commit row to the parent/child row as a single path. |
| **Commit dots (all types)** | Solid fill dots, hollow merge dots, WIP dashed circle, stash square dots. | LOW | Dot positions from (column, row_index) | Conceptually unchanged. Individual SVG `<circle>` or `<rect>` elements at computed (x, y) positions. |
| **WIP dashed connector** | Dashed line from WIP synthetic row to HEAD commit dot. | LOW | WIP sentinel detection, HEAD row index | Currently a single `<line>` using `overflow: visible` to extend into the next row. In overlay model, it becomes a normal `<path>` or `<line>` between two known y-coordinates. |
| **Stash synthetic rows** | Square dots for stash entries, connector to parent commit. | LOW | Stash sentinel OIDs (`__stash_N__`) | Same approach as regular dots but rendered as rectangles. Adapts to new coordinate system. |
| **Three-layer z-ordering** | Rails behind edges behind dots (established in v0.2). | LOW | SVG group ordering | Three `<g>` elements in the overlay SVG in correct order. Simpler than current approach where each per-row SVG must independently maintain layer order. |
| **Virtual scroll compatibility** | Graph overlay must stay pixel-aligned with the virtual list rows as user scrolls. | HIGH | `SvelteVirtualList` scroll events, coordinate mapping | **This is the highest-risk feature.** The overlay SVG must track scroll offset and translate between row indices and pixel y-positions. Must handle: item recycling, variable buffer sizes, scroll at 60fps. |
| **Ref pill connector lines** | Colored lines from ref pills to their commit dots. | MED | Ref pill x-position, commit dot (x, y) | Currently an HTML `<div>` with absolute positioning calculated from `refContainerWidth` and `commit.column * LANE_WIDTH`. In overlay model, becomes an SVG `<line>` or `<path>`. |
| **Color consistency** | 8-color vivid palette (`var(--lane-0)` through `var(--lane-7)`), same color per branch. | LOW | `color_index` from Rust lane algorithm | No change to color assignment. Same CSS custom properties used in SVG `stroke`/`fill`. |
| **Branch tip start position** | Rail starts at dot center (not row top) for the first commit on a branch. | LOW | `is_branch_tip` flag on GraphCommit | Path building detail: the vertical path for a lane starts at `(cx, dot_y)` for the tip row, not `(cx, row_top)`. Currently handled in LaneSvg line 80. |
| **Incoming rail for root commits** | Rail from row top to dot for non-branch-tip commits without a straight edge in their column. | LOW | `needsIncomingRail` derived logic | Edge case where a commit has no straight edge in its own column (e.g., root commits). Must be preserved in new path builder. |
| **Graph column width** | Width adjusts to `max_columns * LANE_WIDTH`, resizable via column resize handle. | LOW | `maxColumns` from GraphResponse, existing resize infrastructure | Width calculation unchanged. The overlay SVG width matches the graph column width. |

---

## Differentiators

Features that the new architecture enables or makes trivial. Not regressions if absent from v0.4, but valuable future additions.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| **Hover-highlight entire branch line** | Hovering a lane highlights the full continuous path (not just one row's segment). Gitea implements this. | MED | Single path per lane (table stakes) | Impossible with per-row fragments. With one `<path>` per lane, add `:hover` CSS or a `mouseenter` JS handler. Major UX improvement for understanding branch topology. |
| **Click-to-select branch flow** | Click a lane path to highlight all commits on that branch. | MED | Hover-highlight, commit filtering | Natural extension of hover. Path element carries lane/color metadata. Could scroll to branch tip or filter commit list. |
| **Smooth rendering (no seam artifacts)** | No pixel-level gaps or misalignment at row boundaries. | FREE | Inherent to single-path approach | This is the primary motivation. Not an additional feature -- it is the reason for the rework. |
| **Reduced DOM element count** | Fewer SVG elements total (N paths vs N*M fragments for N lanes and M visible rows). | FREE | Inherent to approach | With 6 lanes and 40 visible rows, current approach creates ~240+ SVG elements. New approach: ~6 paths + ~40 dots + ~6 merge edges = ~52 elements. |
| **Ref pills as SVG elements** | Convert ref pills from HTML to SVG `<text>` + `<rect>` inside the overlay. | MED-HIGH | SVG text layout, foreignObject or native SVG | Eliminates HTML-to-SVG coordinate synchronization. PROJECT.md lists this as a v0.4 target. SVG text layout is less flexible than HTML, but `foreignObject` is an escape hatch. |
| **Animation-ready architecture** | Single continuous paths can be animated (draw-on, pulse, glow) for visual feedback on push/pull/commit. | LOW | Single-path architecture | Not needed for v0.4, but the architecture naturally supports it for future milestones. |

---

## Anti-Features

Features to explicitly NOT build as part of this rework.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Canvas rendering** | Loses CSS styling (`var(--lane-N)`), accessibility, text selection. Overkill for this geometry. Sublime Merge uses OpenGL because it is native C++, not web. | Stay with SVG. The geometry is simple lines, arcs, circles -- SVG's sweet spot. |
| **WebGL / GPU acceleration** | Massive complexity (shader programs, texture atlases) for geometry that SVG handles natively at 60fps. | Standard SVG. If perf is ever a problem, the bottleneck will be JS coordinate math, not SVG rendering. |
| **Full-history single SVG** | A 10k-commit repo at 26px/row = 260,000px SVG height. Browsers degrade badly above ~10k-20k px for SVG viewports. Chrome compositor can fail silently. | Render paths only for visible viewport + buffer. Clip path data to the scroll window. |
| **Abandoning virtual scrolling** | GitLG loads 15k commits with virtual scrolling and it works. Without virtual scrolling, DOM node count explodes. | Keep `SvelteVirtualList` for commit rows. SVG overlay covers visible viewport only, synchronized with virtual list scroll. |
| **Bezier curves replacing Manhattan routing** | Manhattan routing (H + arc + V) is established, tested, and matches GitKraken/Fork aesthetics. Bezier adds path complexity with subjective visual benefit. | Keep Manhattan routing. Change coordinates, not curve style. |
| **Animated scroll transitions** | SVG path redraw on every scroll frame is already the constraint. Adding CSS transitions or requestAnimationFrame animations on top creates jank risk. | Static path rendering updated synchronously on scroll. Paths snap to position. |
| **Replacing the Rust lane algorithm** | O(n) lane packing runs in ~5ms for 10k commits. Algorithm is proven across v0.2 and v0.3. | Keep Rust algorithm unchanged. Frontend consumes same `GraphCommit[]` / `GraphEdge[]` data. Backend is not part of this rework. |
| **Multi-SVG segmented approach (Bitbucket-style)** | Stitching SVG segments reintroduces boundary management. Defeats the purpose of the rework (eliminating row-boundary bugs). | Single overlay SVG for the visible viewport. One SVG, many paths. |

---

## Feature Dependencies

```
[SVG overlay + scroll sync] ──> [Continuous rail lines]
                             ──> [Continuous merge/fork edges]
                             ──> [Commit dots in overlay]
                             ──> [WIP/stash in overlay]
                             ──> [Ref pill connectors in overlay]

[Continuous rail lines] ──> [Hover-highlight entire branch] (future)
                        ──> [Click-to-select branch flow] (future)

[Commit dots in overlay] ──> [Three-layer z-ordering]
[Continuous rail lines]  ──> [Three-layer z-ordering]
[Merge/fork edges]       ──> [Three-layer z-ordering]

[Ref pill connectors in overlay] ──> [Ref pills as SVG] (optional, can remain HTML)

[Rust lane algorithm] ──(unchanged)──> [All rendering features]
[SvelteVirtualList]   ──(scroll events)──> [SVG overlay + scroll sync]
[graph-constants.ts]  ──(LANE_WIDTH, ROW_HEIGHT)──> [All coordinate calculations]
```

**Critical path:** SVG overlay + scroll synchronization is the foundation. Everything else depends on it.

---

## The Core Architectural Decision: How Overlay Meets Virtual Scroll

Three viable approaches exist. This analysis informs the architecture.

### Approach A: Absolutely-Positioned SVG Overlay (Recommended)

A single `<svg>` element sits absolutely-positioned over the graph column of the virtual list container. Its height matches the visible viewport. On scroll, the SVG content is re-rendered: path coordinates are computed from the visible row range (start index, end index) plus a buffer.

**How it works:**
1. Virtual list fires scroll event with scroll offset (pixels)
2. Compute visible row range: `startRow = floor(scrollTop / ROW_HEIGHT)`, `endRow = startRow + ceil(viewportHeight / ROW_HEIGHT) + buffer`
3. For each lane active in `[startRow, endRow]`: build a vertical `<path>` from `(cx, startY)` to `(cx, endY)`
4. For each merge/fork edge where either endpoint is in `[startRow, endRow]`: build a Manhattan `<path>`
5. For each commit in `[startRow, endRow]`: place a dot at `(cx, (rowIndex - startRow) * ROW_HEIGHT + ROW_HEIGHT/2)`
6. Three `<g>` layers: rails, edges, dots

**Pros:** Clean DOM. Natural z-ordering. Single SVG for hover/click. No HTML-SVG coordinate drift.
**Cons:** Must re-render SVG content on every scroll. Must handle edge-of-viewport partial paths (a lane entering mid-viewport must extend to the top edge, not start at the first visible commit).

### Approach B: viewBox-Shifted SVG

Generate paths for all loaded commits in absolute coordinates. Use a large SVG with `viewBox` shifting to show only the visible portion.

**Pros:** No per-scroll path recalculation.
**Cons:** SVG element contains paths for potentially thousands of commits. Browser must traverse entire SVG tree on every paint even though most is clipped. Scales poorly.

### Approach C: Transform-Shifted SVG

Render all loaded paths in a large SVG, use CSS `transform: translateY(-scrollTop)` to shift it.

**Pros:** Simple implementation.
**Cons:** Same scaling problem as B. Additionally, transforms can cause sub-pixel rendering artifacts.

**Recommendation: Approach A.** Compute paths for visible + buffer rows only. The path computation is trivial (a few dozen paths with simple coordinate math). Re-rendering on scroll is cheap. This keeps the SVG small and performant regardless of total commit count.

---

## MVP Recommendation

### Phase 1: SVG overlay infrastructure + continuous rail lines

Priority: Establish the overlay mechanism and prove scroll synchronization.

1. **Create `GraphOverlay.svelte` component** -- absolutely-positioned SVG over the graph column
2. **Wire scroll synchronization** with `SvelteVirtualList` scroll events
3. **Replace per-row straight-edge `<line>` elements** with continuous `<path>` per active lane
4. **Render commit dots** in the overlay SVG (all types: solid, hollow-merge, WIP, stash)
5. **Establish three-layer `<g>` z-ordering** (rails, edges, dots)
6. **Remove `LaneSvg` rendering** from `CommitRow` (graph column becomes empty; overlay handles it)

**Exit criteria:** Vertical branch lines render as continuous paths, dots align with commit rows, no visual regression on scroll.

### Phase 2: Merge/fork edges + special cases

7. **Replace per-row merge/fork `<path>` elements** with single continuous paths spanning source and target rows
8. **Adapt WIP dashed connector** to overlay coordinate system
9. **Adapt stash square dots** to overlay coordinate system
10. **Handle edge cases:** branch-tip start position, incoming rail for root commits, lanes entering/leaving viewport mid-scroll

**Exit criteria:** All edge types render correctly. Manhattan routing preserved. No row-boundary seam artifacts.

### Phase 3: Ref pill connectors + ref pills

11. **Move ref pill connector lines** to SVG overlay (currently HTML `<div>` with computed width)
12. **Convert ref pills to SVG elements** (SVG `<rect>` + `<text>`, or `<foreignObject>` wrapping existing HTML)
13. **Remove per-row connector div** from `CommitRow.svelte`

**Exit criteria:** Ref pills and connectors render identically to v0.3. No HTML-SVG coordinate drift.

### Defer to v0.5+

- Hover-highlight entire branch line
- Click-to-select branch flow
- Path animations
- These are differentiators enabled by the new architecture but outside the "zero visual change" v0.4 scope.

---

## Complexity Assessment

| Feature Area | Complexity | Risk | Notes |
|-------------|-----------|------|-------|
| SVG overlay + scroll sync | **HIGH** | **HIGH** | The make-or-break challenge. Must handle 60fps scroll, virtual list item recycling, buffer management. If this is sluggish, the whole approach fails. |
| Continuous rail paths | **MEDIUM** | LOW | Path generation from lane data is straightforward. Main work is mapping `(column, rowIndex)` to `(x_px, y_px)` in viewport coordinates. |
| Continuous merge/fork paths | **MEDIUM** | MEDIUM | Manhattan path math exists in `buildEdgePath()`. Must adapt from "within-row coordinates" to "viewport-absolute coordinates." Edge endpoints may be outside the visible viewport (requires extending paths to viewport edges). |
| Commit dots | **LOW** | LOW | Individual positioned elements. Same logic, new coordinate system. |
| WIP/stash adaptation | **LOW** | LOW | Small special cases. WIP is index 0, stash uses sentinel OIDs. |
| Ref pill connectors | **MEDIUM** | MEDIUM | Currently uses HTML `refContainerWidth` binding + CSS absolute positioning. Moving to SVG requires knowing the ref pill rendered width, which is harder in SVG. |
| Ref pills as SVG | **MEDIUM-HIGH** | MEDIUM | SVG text measurement is synchronous (`getComputedTextLength()`), but multi-ref overflow ("+N" badge, hover expansion) is complex to replicate in SVG. `foreignObject` is the pragmatic escape hatch but has Tauri webview quirks. |
| Three-layer z-ordering | **LOW** | LOW | Three `<g>` elements. Simpler than current per-row approach. |
| Remove per-row LaneSvg | **LOW** | LOW | Delete `LaneSvg.svelte` import from `CommitRow`, remove graph column SVG. Clean removal. |

---

## Sources

### MEDIUM confidence (open-source implementations and web standards)
- [Gitea graph rendering PR #12333](https://github.com/go-gitea/gitea/pull/12333) -- server-side SVG replacing Canvas, flow-based hover highlight
- [GitLG virtual scrolling with 15k commits](https://github.com/phil294/GitLG) -- Vue.js graph with configurable curve-radius
- [git-branch-graph SVG + virtual scroll](https://github.com/snailuu/git-branch-graph) -- React SVG optimization for branch lines
- [gitgraph.js pagination discussion](https://github.com/nicoespeon/gitgraph.js/issues/215) -- Bitbucket's segmented SVG approach
- [MDN SVG Paths reference](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths)

### LOW confidence (commercial tools, externally observed only)
- GitKraken graph column -- [feature overview](https://www.gitkraken.com/answers/38324), rendering internals not publicly documented
- Sublime Merge -- uses [custom OpenGL renderer](https://www.sublimemerge.com/blog/sublime-merge-build-1070), not applicable to web tech
- Fork -- native platform rendering, internals not documented

### HIGH confidence (direct codebase analysis)
- `LaneSvg.svelte` -- current per-row SVG rendering with three layers
- `CommitRow.svelte` -- ref pill connector as HTML div with absolute positioning
- `CommitGraph.svelte` -- virtual list integration with `SvelteVirtualList`
- `graph-constants.ts` -- `LANE_WIDTH=12`, `ROW_HEIGHT=26`, `DOT_RADIUS=6`
- `types.ts` -- `GraphCommit`, `GraphEdge`, `EdgeType` data model (unchanged by rework)
- `PROJECT.md` -- v0.4 target: branch lines, merge edges, ref connectors as single paths; ref pills as SVG

---
*Feature research for: Trunk v0.4 -- Graph rendering rework (per-row SVG to full-height SVG overlay)*
*Researched: 2026-03-12*
