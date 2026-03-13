# Feature Landscape: Single SVG Overlay Graph (v0.5)

**Domain:** Git GUI — commit graph visualization
**Researched:** 2026-03-13

## Context

Trunk v0.5 replaces per-row viewBox-clipped SVGs (v0.3-v0.4 approach) with a **single SVG overlay** spanning the entire virtualized list. This is a deliberate reversal of the v0.4 architecture decision (which preferred viewBox clipping). The reversal is justified because:
- Single overlay enables truly continuous `<path>` elements (one path per edge, not stitched fragments)
- Cubic bezier curves spanning multiple rows render as one smooth curve, not segments
- Eliminates row-boundary seam artifacts entirely
- Simpler SVG structure (one SVG vs ~40 per-row SVGs)

---

## Table Stakes (Must Have — Regression If Missing)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Single SVG overlay with native scrolling** | Core architecture. SVG inside scroll viewport scrolls with virtual list natively. | HIGH | Foundation. SVG as sibling inside `#virtual-list-viewport`, `pointer-events: none` root. |
| **TypeScript Active Lanes transformation** | New data layer converting Rust `GraphCommit[]` → `GraphData { nodes[], edges[] }` with global grid coordinates. | HIGH | O(n) pass through commits. Must handle WIP, stash, branch tips, all edge types. Pure function, fully testable. |
| **Cubic bezier waterfall curves** | Replacing Manhattan routing. Visual centerpiece of v0.5. | HIGH | SVG `C` command. Control points enforce vertical tangents at both endpoints: `M x1 y1 C x1 midY, x2 midY, x2 y2`. |
| **Continuous vertical rail lines** | Each lane = one `<path>` spanning all rows where that lane is active. | MEDIUM | `M cx(col) startY V endY` per contiguous lane run. Branch tips start at dot center. |
| **Commit dots (solid, hollow, dashed)** | Distinguish normal, merge, stash/WIP commits. | LOW | SVG `<circle>` at `(cx(col), cy(row))`. Same visual logic as v0.3. |
| **WIP dashed connector** | Dashed line from WIP synthetic row to HEAD commit. | LOW | Single dashed `<path>` between two known Y coordinates. Simpler in overlay model. |
| **Stash synthetic rows + dashed connectors** | Stash entries visible in graph with dashed styling. | LOW | Backend `dashed` flag flows through Active Lanes transformation. |
| **Three-layer z-ordering** | Rails behind edges behind dots. | LOW | Three `<g>` groups in SVG: `<g class="rails">`, `<g class="edges">`, `<g class="dots">`. |
| **Click → commit detail** | Clicking a commit row opens commit detail panel. | LOW | SVG root `pointer-events: none` passes clicks through to HTML CommitRow beneath. |
| **Right-click → context menu** | Right-click shows native Tauri context menu. | LOW | Same pointer-events passthrough. Existing `showCommitContextMenu` fires on HTML row. |
| **Lane coloring (8-color palette)** | Visual branch identity via `var(--lane-N)`. | LOW | CSS custom properties work in SVG `stroke`/`fill`. Unchanged. |
| **Virtual scrolling (~40 DOM nodes)** | Smooth performance for any history size. | LOW | Virtual list unchanged. SVG inside viewport scrolls natively. |
| **Column resize + visibility** | User controls graph column width, hides columns. | LOW | Overlay width bound to `columnWidths.graph` reactively. |
| **SVG ref pills** | Branch/tag labels as SVG `<rect>` + `<text>` inside overlay. | MEDIUM | Replaces HTML RefPill.svelte. Canvas `measureText` for text width. |
| **Ref pill connector lines** | Line from pill to commit dot. | LOW | SVG `<line>` element inside overlay. |
| **Tuned dimensions** | Taller rows, wider lanes for bezier aesthetics. | LOW | `ROW_HEIGHT` 26→36, `LANE_WIDTH` 12→16. |

## Differentiators (Value-Add — Not Expected)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **No row-boundary seams** | Perfectly continuous branch lines, zero visual artifacts. | FREE | Inherent benefit of overlay architecture. |
| **Smooth bezier curves** | Professional GitKraken-quality visual appearance. | Included in table stakes | Sub-pixel anti-aliasing works better with curves than Manhattan arcs. |
| **Reduced DOM element count** | ~50-80 SVG elements total vs ~800 with per-row approach. | FREE | Inherent to single SVG. |
| **Hover-highlight entire branch** | Mouse over a lane highlights full continuous branch flow. | MEDIUM | Natural follow-on — single `<path>` per lane enables CSS `:hover`. Defer to v0.6. |
| **Click-to-select branch flow** | Click a lane to highlight/filter all commits on that branch. | MEDIUM | Extension of hover-highlight. Defer to v0.6. |
| **Animation-ready paths** | Continuous paths can be animated (draw-on, pulse) for feedback. | LOW (architecture) | Not built in v0.5 but overlay architecture naturally supports it. |
| **Ref pill hover expansion (SVG)** | Hover to see all refs when multiple exist on one commit. | MEDIUM | Same UX as current HTML, implemented in SVG with `<g>` visibility toggle. |

## Anti-Features (Do NOT Build)

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Canvas rendering** | Loses CSS custom properties, pointer events, declarative Svelte templates. | SVG only. |
| **Animated transitions between graph states** | Scope creep. Graph refreshes are instant (replace entire data). | Static rendering. |
| **Drag-to-reorder branches** | Not a Git operation. Confusing UX. | Lane ordering from Rust algorithm. |
| **Custom scrollbar for SVG** | Unnecessary — SVG is inside existing scroll container. | Native scrollbar from virtual list viewport. |
| **Graph zoom (pinch/scroll)** | Scope creep. Not in v0.5 requirements. | Fixed scale. Defer to v0.6+. |
| **Full-history single SVG without culling** | 10k commits × 36px = 360,000px height. Browsers degrade >10-20k px. | Render all paths but rely on browser GPU culling. Profile to verify. |
| **Quadratic bezier (Q)** | Only one control point — cannot enforce vertical tangents at BOTH endpoints. | Cubic bezier (C) with two independent control points. |
| **foreignObject for ref pills** | Inconsistent rendering in WebKit/WKWebView (Tauri macOS). | Native SVG `<rect>` + `<text>`. |
| **Replace Rust lane algorithm** | Proven O(n) algorithm, ~5ms/10k commits. Zero benefit to rewriting in TS. | TS layer *transforms* Rust output, not replaces it. |
| **Multi-SVG segmented approach** | Reintroduces boundary management. Same seam artifacts the rework is fixing. | Single overlay SVG. |

---

## Feature Dependencies

```
[Rust lane algorithm] ──(unchanged, produces GraphCommit[])──> [TS Active Lanes]

[TS Active Lanes transformation]
  └──produces──> [GraphData: GraphNode[] + GraphEdge[]]

[Cubic bezier path generation]
  └──requires──> [GraphNode positions from Active Lanes]
  └──called by──> [Active Lanes (inline) or GraphOverlay (at render)]

[SVG overlay component]
  └──requires──> [GraphData from Active Lanes]
  └──requires──> [SVG inside virtual list viewport]
  └──renders──>  [Continuous rail <path> elements]
  └──renders──>  [Cubic bezier edge <path> elements]
  └──renders──>  [Commit dots <circle> elements]
  └──renders──>  [SVG ref pills <g> elements]

[SVG ref pills]
  └──requires──> [SVG overlay working]
  └──requires──> [Canvas measureText for text width]
  └──replaces──> [HTML RefPill.svelte + CommitRow connector div]

[Click/context menu interaction]
  └──requires──> [SVG overlay with pointer-events: none]
  └──preserves──> [CommitRow onclick, oncontextmenu]
```

---

## MVP Recommendation (Build Order)

1. **Active Lanes transformation + bezier path generation** — Foundation. Pure TypeScript, fully testable. Everything depends on `GraphCommit[] → GraphData`.
2. **SVG overlay component with rails + dots** — Prove the overlay positioning inside virtual list viewport. Continuous vertical lines + commit dots.
3. **Cubic bezier edges** — Add merge/fork curves to the overlay. Visual centerpiece.
4. **SVG ref pills** — `<rect>` + `<text>` inside overlay. Connector lines. Canvas `measureText`.
5. **Click/context menu interaction** — Event wiring. Verify all v0.3 interactions preserved.

**Defer:**
- Hover-highlight branch: v0.6 (architecture enables it, but not v0.5 scope)
- Click-to-select branch: v0.6
- Path animations: v0.6+
- Ref pill hover expansion: polish pass after core ref pills work

---

## Sources

- Existing codebase: `GraphCell.svelte`, `CommitRow.svelte`, `RefPill.svelte`, `CommitGraph.svelte`, `graph-svg-data.ts`, `graph-constants.ts`, `types.ts`
- v0.5 scope: `.planning/PROJECT.md` lines 37-49
- SVG spec: MDN cubic bezier curves, pointer-events, rect/text elements
- Commercial Git GUIs: GitKraken (cubic bezier waterfall), Fork (bezier), Tower (rounded arc) — externally observed

---
*Feature landscape for: Trunk v0.5 — Single SVG overlay graph*
*Researched: 2026-03-13*
