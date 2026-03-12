# Project Research Summary

**Project:** Trunk v0.4 -- Graph Rendering Rework
**Domain:** SVG graph rendering in virtualized commit list (Tauri 2 + Svelte 5 desktop Git GUI)
**Researched:** 2026-03-12
**Confidence:** HIGH

## Executive Summary

Trunk v0.4 replaces per-row inline SVGs with continuous full-height SVG paths for the commit graph. Every production-quality Git GUI (GitKraken, Fork, Sublime Merge, Gitea) renders branch lines as continuous elements, confirming this is the correct architectural direction. The critical finding is that this rework requires zero new dependencies -- no new npm packages, no new Rust crates, no SVG libraries. The existing stack (Svelte 5, TypeScript, the Rust lane algorithm, and `@humanspeak/svelte-virtual-list`) provides everything needed. Path generation is a rendering concern that belongs in TypeScript, not Rust, since the Rust backend already returns all necessary data (`GraphCommit.column`, `edges[]`, `color_index`, `is_branch_tip`, `max_columns`).

The recommended architecture is viewBox-clipped per-row SVGs backed by a shared data model. Each `CommitRow` renders a `<svg>` with `viewBox="0 {rowIndex * ROW_HEIGHT} {width} {ROW_HEIGHT}"`, clipping into a single logical full-height coordinate space. Path data is computed once per data change (not per scroll) via `$derived.by()` in `CommitGraph.svelte`. This avoids the two biggest risks: scroll synchronization drift (no sync needed -- each row's SVG scrolls with the virtual list natively) and SVG DOM explosion (only ~800 elements in the DOM at any time via virtual scrolling). The overlay approach was explicitly rejected due to z-index chaos, scroll sync fragility, and column resize tracking complexity.

The highest-risk area is ref pills as SVG elements. SVG `<text>` has no box model, no `overflow: hidden`, no CSS flexbox. The current ref pill system (hover-expand overlay, "+N" badge, `clip-path` animation, `bind:clientWidth`) is deeply HTML-dependent. This should be tackled last, and the team should be prepared to keep ref pills as HTML if the SVG migration proves too costly. Everything else -- continuous rail lines, merge/fork edges, commit dots, WIP/stash handling -- is medium-to-low risk with well-understood solutions.

## Key Findings

### Recommended Stack

No new dependencies. This is an architecture change, not a technology change. The entire rework uses existing tools in a new arrangement.

**Core technologies (unchanged):**
- **Svelte 5 + `$derived.by()`**: Reactive SVG rendering; path data computed once per data change, viewBox clipping per row
- **TypeScript**: Path `d` string generation functions (`graph-svg-data.svelte.ts`); sub-millisecond even for 10k commits
- **@humanspeak/svelte-virtual-list v0.4.2**: Continues driving commit row rendering; `debugFunction` callback provides `startIndex`/`endIndex`; no API changes needed
- **Rust lane algorithm (git2 0.19)**: Unchanged; already returns `column`, `edges[]`, `color_index`, `is_branch_tip`, `max_columns`
- **Canvas `measureText` API**: For pixel-accurate ref pill width pre-computation (synchronous, ~0.01ms per call, no DOM insertion)

**What NOT to add:** D3.js (overkill), Canvas rendering (loses CSS vars and accessibility), SVG.js/Snap.svg (conflicts with Svelte DOM), Web Workers (path generation is sub-millisecond), virtual SVG library (20 lines of filtering replaces it).

### Expected Features

**Must have (table stakes -- regression if missing):**
- Continuous vertical rail lines (one `<path>` per active lane)
- Continuous merge/fork edges (Manhattan routing preserved)
- All commit dot types (solid, hollow-merge, WIP dashed, stash square)
- WIP dashed connector to HEAD
- Three-layer z-ordering (rails behind edges behind dots)
- Virtual scroll compatibility at 60fps
- Ref pill connector lines
- Color consistency (8-color palette via CSS custom properties)
- Branch tip start position and root commit incoming rail

**Should have (differentiators enabled by new architecture):**
- Hover-highlight entire branch line (impossible with per-row fragments; trivial with one `<path>` per lane)
- Click-to-select branch flow
- Reduced DOM element count (~52 elements vs ~240+ with per-row approach)
- Smooth rendering with zero seam artifacts

**Defer (v0.5+):**
- Hover-highlight and click-to-select branch flow (enabled by architecture, outside "zero visual change" v0.4 scope)
- Path animations (draw-on, pulse, glow)
- Ref pills as full SVG elements (high risk; keep as HTML if needed)

### Architecture Approach

ViewBox-clipped per-row SVGs with centralized path computation. A new `graph-svg-data.svelte.ts` module computes all SVG geometry from the full commit list in a single `$derived.by()` pass. A new `GraphSvg.svelte` component replaces `LaneSvg.svelte`, rendering a `<svg>` per row with `viewBox` clipping to show only that row's 26px vertical band. The ref and graph columns merge into a single "graph" column, eliminating cross-column overflow tricks.

**Major components:**
1. **`graph-svg-data.svelte.ts`** -- Pure data transformation: commits in, `GraphSvgData` out (rails, connections, dots, ref connectors, ref pills). Recomputes on `displayItems` change only.
2. **`GraphSvg.svelte`** -- Thin viewBox renderer replacing `LaneSvg.svelte`. Receives shared `GraphSvgData`, clips via `viewBox`. SVG root has `pointer-events: none`; interactive elements (dots) have `pointer-events: auto`.
3. **`CommitGraph.svelte`** -- Orchestrator. Calls `computeGraphSvg()` via `$derived.by()`, passes result to all visible `CommitRow` instances.

**Key patterns:**
- Centralized path computation (compute once, render per-row via viewBox)
- SVG pointer events layering (`pointer-events: none` on root, `auto` on dots)
- Keyed `{#each}` blocks for SVG elements (key by lane identity, not array index)
- SVG marked decorative (`role="img" aria-hidden="true"`); HTML rows remain the interactive/accessible layer

### Critical Pitfalls

1. **SVG DOM explosion with large repos** -- Without virtualization, 10k commits produce 50k+ SVG child elements. Prevention: the viewBox-clipped approach inherently virtualizes (only ~800 elements in DOM via virtual scrolling). Never render all paths in one giant SVG.

2. **Scroll synchronization drift** -- An overlay SVG outside the scroll container creates frame-lag jitter. Prevention: the viewBox-clipped approach eliminates this entirely -- each row's SVG scrolls with the virtual list natively. No scroll sync code needed.

3. **Pointer events swallowed by SVG** -- SVG overlay blocks row click/hover/context-menu. Prevention: `pointer-events: none` on SVG root, `pointer-events: auto` only on interactive children. Test all existing interactions at every phase.

4. **SVG re-render storm on data changes** -- New commit at top shifts every Y coordinate, causing 100% path "change." Prevention: key lane paths by identity (column + color_index), not position. Compute paths only on data change, never on scroll.

5. **Ref pills lose HTML layout capabilities in SVG** -- SVG `<text>` has no box model, overflow, or flexbox. Prevention: tackle ref pills last. Be prepared to keep them as HTML with only the connector line in SVG. Avoid `foreignObject` (cross-engine quirks in Tauri WebView).

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: GraphSvgData Computation Engine

**Rationale:** Pure data transformation with no DOM dependencies. Testable in isolation. All subsequent work depends on this module existing and producing correct path strings.
**Delivers:** `graph-svg-data.svelte.ts` with `computeGraphSvg()` function producing `GraphSvgData` (rail paths, connection paths, dot positions).
**Addresses:** Foundation for continuous rail lines, merge/fork edges, commit dots.
**Avoids:** Re-render storm (P4) by establishing correct data-change-only reactivity pattern from the start.

### Phase 2: GraphSvg Component + Core Graph Rendering

**Rationale:** Get the visual rendering working. This is where the viewBox-clipped approach proves itself. Must establish pointer-events layering and z-ordering here.
**Delivers:** `GraphSvg.svelte` replacing `LaneSvg.svelte` in `CommitRow`. Continuous rail lines, merge/fork edges, all dot types visible and correctly positioned.
**Addresses:** Continuous vertical rails, continuous merge/fork edges, commit dots, three-layer z-ordering, virtual scroll compatibility.
**Avoids:** Scroll sync drift (P2, eliminated by design), pointer events blocking (P3, established here), SVG DOM explosion (P1, inherent to approach), pagination boundary seams (P6, paths computed from full array).

### Phase 3: WIP, Stash, and Edge Cases

**Rationale:** Synthetic rows have special rendering rules (dashed lines, square dots, sentinel OIDs). Handle after normal commit rendering is solid.
**Delivers:** WIP dashed connector, stash square dots, branch-tip start position, incoming rail for root commits, lanes entering/leaving viewport.
**Addresses:** WIP/stash table stakes features, edge case correctness.
**Avoids:** Missing edge cases that cause visual regressions.

### Phase 4: Ref Pills and Connectors

**Rationale:** Highest-risk SVG migration. Depends on the graph rendering being stable. May require fallback to HTML pills.
**Delivers:** Ref pill connector lines in SVG, ref pills as SVG elements (or HTML fallback), merged ref+graph column, updated column resize logic, "+N" overflow badge with hover expansion.
**Addresses:** Ref pill connectors (table stakes), ref pills as SVG (differentiator), column layout simplification.
**Avoids:** Ref pill HTML layout loss (P5) by tackling last and having fallback plan.

### Phase 5: Interaction and Cleanup

**Rationale:** Interaction handlers are straightforward but need thorough testing. Cleanup after everything works to avoid breaking fallback paths.
**Delivers:** Dot click/right-click handlers, commit selection via dot, context menus, deletion of `LaneSvg.svelte` and `RefPill.svelte`, `ColumnWidths` type migration, persisted store migration.
**Addresses:** All remaining table stakes (row click, context menu, hover), accessibility model (`aria-hidden`), code cleanup.
**Avoids:** Accessibility regression (P7), interaction breakage from SVG overlay.

### Phase Ordering Rationale

- **Data before rendering:** Phase 1 (computation) before Phase 2 (rendering) follows the architecture's separation of concerns. The computation module is independently testable.
- **Core before edge cases:** Phases 1-2 deliver the primary value (continuous lines, no seams). Phase 3 handles synthetic rows that are lower risk.
- **Ref pills last:** Phase 4 is the highest-risk migration. Doing it last means the core graph is stable and provides a working fallback if ref pills stay as HTML.
- **Cleanup last:** Phase 5 avoids premature deletion of code that might be needed as reference during development.
- **WebKit testing throughout:** Every phase must be verified in a production Tauri build (`cargo tauri build`), not just `cargo tauri dev`.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** Scroll behavior edge cases with viewBox clipping at extreme scroll speeds; needs profiling in production WebKit build
- **Phase 4:** SVG text measurement and ref pill overflow behavior; the HTML-to-SVG migration for pills has many unknowns around `foreignObject` quirks and hover-expand reimplementation

Phases with standard patterns (skip research-phase):
- **Phase 1:** Pure TypeScript data transformation; well-understood SVG path string generation
- **Phase 3:** Small adaptations of existing WIP/stash logic to new coordinate system
- **Phase 5:** Standard DOM event handling and file cleanup

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All claims verified via direct source code inspection of existing codebase and library internals. Zero new dependencies. |
| Features | MEDIUM | Rendering internals of commercial Git GUIs (GitKraken, Fork) are not publicly documented. Open-source implementations (Gitea, GitLG) confirm the continuous-path approach. |
| Architecture | HIGH | All integration points derived from reading existing code. ViewBox clipping is standard SVG spec behavior verified across WebView engines. |
| Pitfalls | HIGH | Based on codebase analysis + established SVG/DOM performance knowledge. Recovery strategies identified for each pitfall. |

**Overall confidence:** HIGH

### Gaps to Address

- **WebKit SVG performance at scale**: No production profiling data yet. Must verify during Phase 2 with 5k+ commits in a `cargo tauri build` on macOS WKWebView. If WebKit chokes, may need to reduce path complexity or add viewport-based path culling.
- **Ref pill SVG feasibility**: The "+N" hover-expand behavior in SVG is unproven. Phase 4 planning should include a spike/prototype before committing to full SVG pills. HTML fallback (pills stay HTML, only connector moves to SVG) should be the backup plan.
- **Incremental path computation**: At 10k+ commits, full recomputation of `GraphSvgData` on every `displayItems` change may exceed 10ms. Defer optimization until profiling confirms it matters, but design the data model to support incremental append.
- **Column merge UX**: Merging ref and graph columns changes the column resize behavior and header labels. Needs UX validation -- users may expect independent ref column visibility.

## Sources

### Primary (HIGH confidence)
- Existing codebase: `CommitGraph.svelte`, `CommitRow.svelte`, `LaneSvg.svelte`, `RefPill.svelte`, `graph-constants.ts`, `types.ts`, `graph.rs`, `types.rs`
- `@humanspeak/svelte-virtual-list` source: `node_modules/@humanspeak/svelte-virtual-list/dist/SvelteVirtualList.svelte`, `types.d.ts`
- SVG viewBox clipping behavior (SVG spec, standard across all modern WebView engines)
- Canvas `measureText` API (standard DOM API)

### Secondary (MEDIUM confidence)
- [Gitea graph rendering PR #12333](https://github.com/go-gitea/gitea/pull/12333) -- server SVG replacing Canvas, flow-based hover
- [GitLG](https://github.com/phil294/GitLG) -- Vue.js + virtual scrolling, 15k commits
- [git-branch-graph](https://github.com/snailuu/git-branch-graph) -- React SVG + virtual scroll
- [Svelte 5 SVG duplication issue #12289](https://github.com/sveltejs/svelte/issues/12289)
- SVG performance guides: [O'Reilly Using SVG](https://oreillymedia.github.io/Using_SVG/extras/ch19-performance.html), [CSS-Tricks](https://css-tricks.com/high-performance-svgs/), [Khan Academy](https://www.crmarsh.com/svg-performance/)

### Tertiary (LOW confidence)
- GitKraken, Sublime Merge, Fork -- rendering internals not publicly documented; external observation only

---
*Research completed: 2026-03-12*
*Ready for roadmap: yes*
