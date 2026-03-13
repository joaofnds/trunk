# Project Research Summary

**Project:** Trunk v0.5 — Single SVG Overlay Graph
**Domain:** Git GUI — commit graph visualization (Tauri 2 + Svelte 5 + Rust)
**Researched:** 2026-03-13
**Confidence:** HIGH

## Executive Summary

Trunk v0.5 replaces the per-row viewBox-clipped SVG rendering model (v0.3–v0.4) with a single SVG overlay spanning the entire virtualized commit list. This is a rendering architecture change — not a dependency change. **Zero new npm packages or Rust crates are needed.** Every required capability (cubic bezier paths, SVG overlay positioning, pointer event passthrough, text measurement) is built into browser primitives and Svelte's native SVG handling. The Rust backend lane algorithm is unchanged; a new TypeScript transformation layer ("Active Lanes") bridges Rust's per-row edge descriptors into continuous multi-row edge spans suitable for the overlay.

The recommended approach is to place the SVG inside the virtual list's scroll container (`.virtual-list-content` div) so it scrolls natively — eliminating all scroll synchronization code. The transformation is a single pure function wired via `$derived.by()`, matching the existing codebase pattern. Cubic bezier curves replace Manhattan routing for a GitKraken-style waterfall aesthetic, using the SVG `C` command with vertical tangent control points. Ref pills migrate from HTML `<span>` elements to SVG `<rect>` + `<text>` inside the overlay.

The primary risk is the v0.4 reversal: v0.4 explicitly scoped out the single SVG overlay, citing "DOM explosion at scale." v0.5 bets that SVG virtualization (rendering only visible-range elements) resolves this concern. This must be validated in Phase 1 before investing in curve rendering. Secondary risks include bezier curve aesthetics at adjacent rows (1-2 row gaps produce kinked curves without per-distance tension tuning) and WebKit performance differences in production Tauri builds. A graceful fallback exists: if the overlay approach fails, bezier curves and dimension tuning work equally well with enhanced per-row viewBox clipping.

## Key Findings

### Recommended Stack

No new dependencies. The existing stack covers all v0.5 requirements. This is purely an architecture and algorithm change within the current technology surface.

**Core technologies (unchanged):**
- **Svelte 5** (`^5.0.0`): Reactive SVG rendering via `$derived.by()`, native SVG element support in templates
- **@humanspeak/svelte-virtual-list** (`^0.4.2`): Drives commit row virtualization; overlay syncs via DOM placement inside its scroll viewport
- **TypeScript** (`~5.6.2`): Active Lanes transformation, bezier path generation, new `GraphNode`/`GraphEdge`/`GraphData` types
- **Rust git2** (`0.19`): Lane algorithm unchanged — already returns `GraphCommit[]` with column/edges/refs
- **vitest** (`^4.1.0`): Unit tests for transformation and path functions (established pattern)
- **SVG `C` command**: Cubic bezier curves — W3C spec primitive, no library needed
- **Canvas `measureText()`**: Synchronous text width measurement for ref pill sizing

**What NOT to add:** D3.js (108KB, unused features), SVG.js/Snap.svg (conflicts with Svelte), Canvas rendering (loses CSS vars + pointer events), Dagre/ELK (we already have a graph layout from Rust), any scroll sync library (SVG inside viewport scrolls natively).

### Expected Features

**Must have (table stakes — regression if missing):**
- Single SVG overlay with native scrolling inside virtual list viewport
- TypeScript Active Lanes transformation (`GraphCommit[]` → `GraphData`)
- Cubic bezier waterfall curves replacing Manhattan routing
- Continuous vertical rail lines (one `<path>` per lane run)
- Commit dots (solid/hollow/dashed for normal/merge/stash)
- WIP + stash synthetic rows with dashed connectors
- Three-layer z-ordering (rails → edges → dots)
- SVG ref pills (`<rect>` + `<text>`) with connector lines
- Click-to-select and right-click context menu preservation
- Lane coloring (8-color CSS custom property palette)
- Column resize + visibility reactivity
- Tuned dimensions: `ROW_HEIGHT` 26→36px, `LANE_WIDTH` 12→16px

**Should have (differentiators — free or natural follow-ons):**
- Zero row-boundary seams (inherent to overlay architecture)
- Reduced DOM element count (~50-80 SVG elements vs ~800 per-row)
- Smooth sub-pixel anti-aliased curves

**Defer (v0.6+):**
- Hover-highlight entire branch (architecture enables it but out of scope)
- Click-to-select branch flow
- Path draw-on animations
- Ref pill hover expansion (complex SVG text layout — do last or defer)

### Architecture Approach

The target architecture introduces a TypeScript transformation layer between Rust output and SVG rendering. Rust's `GraphCommit[]` flows through `buildGraphData()` (Active Lanes algorithm) to produce `GraphData` with integer grid coordinates, which `graph-overlay-paths.ts` converts to SVG `d` strings. The `GraphOverlay.svelte` component renders a single `<svg>` with three `<g>` layers (edges, dots, ref pills) positioned absolutely inside the virtual list's `.virtual-list-content` div. CommitRow is simplified to a spacer div + text columns — no more GraphCell or HTML RefPill.

**Major components:**
1. **`active-lanes.ts`** — Pure TS transformation: `GraphCommit[]` → `GraphData` (nodes, edges, ref pills, maxLanes). Edge coalescing reduces O(commits × lanes) to O(lanes + merge_edges).
2. **`graph-overlay-paths.ts`** — Converts grid coordinates to SVG path `d` strings. Cubic bezier for cross-lane edges, vertical lines for same-lane rails.
3. **`GraphOverlay.svelte`** — Single SVG overlay component. `pointer-events: none` root, three `<g>` layers, positioned inside virtual list content div via `$effect` DOM injection.
4. **`SvgRefPill.svelte`** — SVG `<rect>` + `<text>` ref pill. Canvas `measureText()` for width calculation.
5. **`CommitGraph.svelte` (modified)** — Orchestrator. Replaces `computeGraphSvgData` with `buildGraphData`, injects SVG into virtual list DOM.

**Files deleted:** `GraphCell.svelte`, `LaneSvg.svelte`, `graph-svg-data.ts`, `graph-svg-data.test.ts`, `RefPill.svelte` (from graph context; kept for sidebar).

### Critical Pitfalls

1. **SVG DOM explosion (P1)** — Single SVG with 10k+ commits could contain 20-50k child elements. **Prevention:** SVG virtualization — render only visible range + buffer, hard limit of 500 SVG children regardless of total commits. Pre-compute paths, filter on scroll. **This is the make-or-break risk.**

2. **Scroll synchronization drift (P2)** — Overlay and virtual list fall out of sync. **Prevention:** Place SVG inside `.virtual-list-content` so it scrolls natively. Zero JS scroll sync code. DOM injection via `$effect` + `querySelector('.virtual-list-content')`.

3. **Pointer events swallowed (P3)** — SVG overlay captures all clicks in graph column. **Prevention:** `pointer-events: none` on SVG root, `pointer-events: auto` only on interactive elements (ref pills, optionally dots). All row interactions fire on HTML beneath.

4. **Ugly bezier curves at adjacent rows (P4)** — Cubic bezier degenerates to kinked diagonals when commits are 1-2 rows apart (the most common case). **Prevention:** Per-distance tension tuning with minimum control point offset. Visual testbed before shipping.

5. **Ref pill SVG migration complexity (P5)** — SVG `<text>` has no `text-overflow`, no flexbox, no `clientWidth`. Hover-expand animation won't port. **Prevention:** Build ref pills last. Have HTML fallback ready. Consider `foreignObject` escape hatch.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation — Types, Constants, and Overlay Container
**Rationale:** The overlay positioning inside the virtual list is the highest-risk architectural decision. Validate it works before writing any transformation code. Also establishes types that all subsequent phases depend on.
**Delivers:** `graph-overlay-types.ts` with all new interfaces, updated `graph-constants.ts` (new ROW_HEIGHT/LANE_WIDTH/DOT_RADIUS), empty `GraphOverlay.svelte` proving SVG-inside-viewport scroll sync works, `pointer-events: none` passthrough verified.
**Addresses:** Feature dependency root (types/constants), virtual list integration.
**Avoids:** P1 (DOM explosion — establish virtualization strategy), P2 (scroll sync — prove native scroll works), P3 (pointer events — verify passthrough).
**Decision gate:** If scroll sync or pointer passthrough fails here, evaluate fallback to enhanced per-row viewBox before proceeding.

### Phase 2: Data Layer — Active Lanes Transformation
**Rationale:** The transformation is a pure function with zero UI dependencies — fully testable in isolation. All rendering phases depend on it.
**Delivers:** `active-lanes.ts` implementing `buildGraphData()`, comprehensive unit tests ported from existing `graph-svg-data.test.ts` scenarios. Handles WIP, stash, branch tips, all edge types. Edge coalescing for DOM count reduction.
**Addresses:** Table stakes: Active Lanes transformation, edge coalescing.
**Avoids:** P6 (data sync bugs — single pure function, no mutable state), P15 ($derived scope — minimal reactive dependencies).

### Phase 3: Path Builder — Bezier Curve Generation
**Rationale:** Can be built in parallel with Phase 2 (depends only on Phase 1 types). Separating path math from transformation logic keeps both testable.
**Delivers:** `graph-overlay-paths.ts` with `buildBezierPath()`, straight-line paths for same-lane edges, per-distance tension tuning for adjacent/nearby/distant rows. Unit tests for all edge distance cases.
**Addresses:** Table stakes: cubic bezier waterfall curves, continuous rail lines.
**Avoids:** P4 (ugly adjacent-row curves — per-distance tension), P9 (lane overlap — z-ordered `<g>` groups, accepted controlled overlap), P8 (GC pressure — pre-compute all `d` strings once).

### Phase 4: SVG Rendering — GraphOverlay Component
**Rationale:** With transformation and paths ready, build the actual SVG rendering. This is where the architecture proves itself visually.
**Delivers:** `GraphOverlay.svelte` rendering three `<g>` layers (edges, dots, rails). SVG virtualization filtering by visible row range. Keyed `{#each}` loops for stable DOM identity. Visual verification against real repos.
**Addresses:** Table stakes: three-layer z-ordering, commit dots, lane coloring, virtual scrolling with overlay.
**Avoids:** P1 (DOM explosion — virtualization filter active), P12 (Svelte keying — stable edge/dot IDs), P7 (path duplication — eliminated by single SVG).

### Phase 5: Integration — CommitGraph + CommitRow Refactor
**Rationale:** Replace the old rendering pipeline. CommitGraph switches from `computeGraphSvgData` to `buildGraphData`, injects overlay. CommitRow drops GraphCell for a spacer div.
**Delivers:** Modified `CommitGraph.svelte` and `CommitRow.svelte`. Deletion of `GraphCell.svelte`, `LaneSvg.svelte`, `graph-svg-data.ts`. End-to-end working graph with bezier curves.
**Addresses:** Table stakes: column resize reactivity, dimension tuning.
**Avoids:** P11 (pagination seams — full-array recomputation), P13 (column resize desync — reactive SVG width binding), P10 (WebKit perf — test production build here).

### Phase 6: Interaction Preservation
**Rationale:** With rendering working, verify all v0.3/v0.4 interactions are preserved. This is a verification + wiring phase.
**Delivers:** Click-to-select via HTML rows, right-click context menu, row hover highlighting, WIP row click, stash context menu. SVG dot/pill click handlers if needed.
**Addresses:** Table stakes: click → commit detail, right-click → context menu.
**Avoids:** P3 (pointer events — comprehensive interaction testing).

### Phase 7: SVG Ref Pills
**Rationale:** Highest-risk SVG element due to HTML feature dependencies. Build last so everything else is stable. Have HTML fallback ready.
**Delivers:** `SvgRefPill.svelte` with `<rect>` + `<text>`, Canvas `measureText()` for sizing, connector lines as SVG `<line>` elements. Removal of HTML ref pill from CommitRow graph column.
**Addresses:** Table stakes: SVG ref pills, ref pill connector lines.
**Avoids:** P5 (HTML capability loss — simplify hover-expand or defer it), P14 (coordinate mismatch — both endpoints in SVG coordinates).

### Phase Ordering Rationale

- **Foundation first (Phase 1):** The overlay-inside-viewport pattern is the riskiest bet. Validate before investing in data/rendering code. This is the v0.4 reversal — prove it works or fail fast.
- **Data before rendering (Phases 2-3 before 4):** Pure functions are testable without UI. Path builder can run in parallel with Active Lanes since both depend only on types.
- **Integration after components (Phase 5 after 4):** Get the overlay rendering correctly in isolation before wiring it into the existing component tree.
- **Interactions after integration (Phase 6):** Can only verify interactions with the full component stack in place.
- **Ref pills last (Phase 7):** Highest risk of HTML→SVG migration issues. Everything else must be solid before tackling this. If it fails, fall back to HTML pills with SVG connector lines.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1 (Foundation):** Needs validation of SVG-inside-virtual-list DOM injection. The `$effect` + `querySelector('.virtual-list-content')` approach couples to library internals. May need alternative if library updates.
- **Phase 3 (Bezier Curves):** Adjacent-row curve aesthetics require visual tuning. GitKraken may use piecewise "waterfall" routing (vertical + bezier + vertical) rather than single cubic bezier. Needs visual testbed.
- **Phase 7 (Ref Pills):** SVG text layout limitations are well-documented but the specific hover-expand interaction port is uncharted. May need `foreignObject` research.

Phases with standard patterns (skip research-phase):
- **Phase 2 (Active Lanes):** Straightforward O(n) data transformation. Pure function, established testing pattern. Well-understood algorithm.
- **Phase 4 (SVG Rendering):** Standard Svelte SVG templating with `{#each}` loops. No unknowns.
- **Phase 5 (Integration):** Follows existing `CommitGraph.svelte` patterns. Replace one derivation, inject one component.
- **Phase 6 (Interactions):** `pointer-events` CSS property is fully specified. Verification phase, not implementation.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. All capabilities map to browser primitives verified against W3C specs and library source code. |
| Features | HIGH | Feature list grounded in existing codebase analysis and PROJECT.md scope. Clear table stakes vs differentiators. |
| Architecture | HIGH | Virtual list DOM structure verified from library source. Data flow follows established `$derived.by()` pattern. SVG overlay inside scroll container is standard. |
| Pitfalls | HIGH | Based on direct codebase analysis, v0.4 retrospective, and SVG/WebKit performance knowledge. v0.4 reversal risk explicitly acknowledged. |

**Overall confidence:** HIGH

### Gaps to Address

- **SVG virtualization performance threshold:** The 500-element hard limit is a heuristic. Actual threshold for WebKit jank needs empirical profiling with `cargo tauri build` on macOS. Profile at Phase 4 milestone.
- **Adjacent-row bezier aesthetics:** The control point formula (`midY` approach) is theoretical. Real-world appearance with Trunk's lane layout needs visual testing against GitKraken. May require piecewise waterfall routing instead of single cubic bezier.
- **WebKit vs Blink SVG performance:** WebKit bezier rasterization cost relative to Blink is training-data inference, not benchmarked. Test in production build at every phase milestone.
- **Virtual list DOM injection stability:** `querySelector('.virtual-list-content')` couples to library internals. The `id="virtual-list-content"` fallback exists, but any library update could break this. Pin version and document coupling.
- **Ref pill hover-expand in SVG:** No known implementation of CSS `clip-path` animation on SVG `<g>` groups. May need completely different UX (tooltip/popover) or `foreignObject` wrapper.

## Sources

### Primary (HIGH confidence)
- **Codebase analysis:** `CommitGraph.svelte`, `CommitRow.svelte`, `GraphCell.svelte`, `graph-svg-data.ts`, `graph-constants.ts`, `types.ts`, `graph.rs`, `types.rs`
- **Library source:** `@humanspeak/svelte-virtual-list` v0.4.2 — DOM structure (4-layer: container→viewport→content→items), `debugFunction` callback, full API surface
- **Project docs:** `.planning/PROJECT.md` v0.5 scope, `.planning/RETROSPECTIVE.md` risk patterns

### Secondary (MEDIUM confidence)
- [MDN SVG Paths — cubic bezier](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths#curve_commands) — `C` command specification
- [MDN pointer-events](https://developer.mozilla.org/en-US/docs/Web/CSS/pointer-events) — `none`/`auto` values
- [MDN Canvas measureText](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/measureText) — synchronous text width
- [SVG Performance — O'Reilly Using SVG](https://oreillymedia.github.io/Using_SVG/extras/ch19-performance.html) — DOM node count thresholds

### Tertiary (LOW confidence)
- WebKit SVG bezier rasterization cost — training data only, needs empirical profiling
- GitKraken curve rendering specifics — closed source, externally observed. "Waterfall" piecewise routing is inference.

---
*Research completed: 2026-03-13*
*Ready for roadmap: yes*
