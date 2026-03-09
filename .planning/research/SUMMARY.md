# Project Research Summary

**Project:** Trunk v0.2 -- GitKraken-quality Commit Graph
**Domain:** DAG commit graph visualization in a desktop Git GUI (Tauri 2 + Svelte 5 + Rust)
**Researched:** 2026-03-09
**Confidence:** HIGH

## Executive Summary

Building GitKraken-quality commit graph lane rendering requires zero new dependencies. The existing Rust backend already computes all necessary lane data (column assignments, edge types, pass-through edges, color indices) via an O(n) single-pass algorithm. The frontend gap is purely rendering: `LaneSvg.svelte` currently draws only a commit dot and ignores the rich edge data the backend provides. The work is a single component rewrite (LaneSvg.svelte) plus minor Rust/TypeScript plumbing to expose two new fields (`max_columns` and `is_branch_tip`). The rendering technique is per-row inline SVG with `overflow: visible`, using cubic Bezier `C` commands with a 0.8 control-point factor for smooth curves -- the same approach used by vscode-git-graph, the most popular open-source git graph renderer.

The recommended approach is a strict bottom-up build order: harden the Rust lane algorithm first (fix potential ghost lanes and lane collisions, add octopus merge test fixtures), then add the two new data fields, then rewrite LaneSvg in three incremental steps (straight rails, then curves, then dot/polish). This order ensures rendering code always consumes correct data, and each step produces a visible improvement that can be verified before moving on. The 8 table-stakes features identified in research all have existing backend support; the work is almost entirely frontend SVG rendering.

The primary risks are sub-pixel gaps between adjacent row SVGs (the likely cause of v0.1's lane rendering failure), inconsistent SVG widths causing jagged commit message alignment, and Bezier curve misalignment at row boundaries. All three have well-documented prevention strategies: 0.5px line overlap with `overflow: visible`, fixed graph pane width from `max_columns`, and a single logical curve split across rows rather than two independent curves. These must be addressed in the first rendering phase -- they are the difference between "looks broken" and "looks professional."

## Key Findings

### Recommended Stack

No new dependencies are needed. The rendering is pure SVG path math -- at most 5-6 path types, each a single `<path>` element with a computed `d` attribute. Libraries like d3, snap.svg, and svg.js were evaluated and rejected (30-100KB for what amounts to string concatenation). Canvas rendering was also rejected -- it breaks text selection, accessibility, CSS styling, and Svelte's declarative model.

**Core technologies (all existing, unchanged):**
- **Tauri 2 + Rust + git2:** Desktop shell and git operations -- provides the lane algorithm and commit data
- **Svelte 5:** UI framework -- `$derived` reactivity for path string computation, fine-grained updates
- **Pure inline SVG:** Per-row `<svg>` with `overflow: visible` -- no SVG library needed, ~50 lines of path math
- **@humanspeak/svelte-virtual-list:** Virtual scrolling -- ~40 DOM nodes regardless of history size
- **CSS custom properties:** Lane colors via `var(--lane-N)` -- enables theme customization without component changes

### Expected Features

**Must have (table stakes -- defines "GitKraken-quality"):**
- T1: Vertical lane rails -- continuous colored lines per active branch
- T2: Smooth Bezier curves for merge/fork connections
- T3: Lane color consistency per branch (already working via `color_index`)
- T4: Lane packing / column reclamation (already implemented in Rust, needs verification)
- T5: Merge commit visual distinction (partially done, needs polish)
- T6: Pass-through lanes for all active branches through every row
- T7: HEAD-chain pinned to column 0 (already implemented in Rust)
- T8: WIP row connected to HEAD commit via lane line

**Should have (differentiators, ship soon after MVP):**
- D5: Dim/ghost merge commits -- CSS opacity toggle, reduces noise
- D2: Ref label color connection to lane -- small colored indicator matching branch lane
- D4: Graph width control -- configurable `laneWidth` via drag handle

**Defer to v0.3+:**
- D1: Crossing-lane detection with visual offset (complex, edge case)
- D3: Collapsible merge trains (significant new feature requiring UI state + lane recalculation)
- D6: Author avatars (network dependency)
- D7: Keyboard navigation (separate milestone)
- D8: Animated edge transitions (polish, may conflict with virtual scrolling)
- D9: Branch-specific color overrides (requires config store + Rust algorithm change)

### Architecture Approach

The architecture change is minimal by design. The Rust algorithm already emits all edge data (pass-through straights, forks, merges) per commit row. Two small additions are needed: a `max_columns` field for consistent SVG width across all rows, and an `is_branch_tip` boolean for correct incoming-rail rendering. The frontend change is concentrated in a single component rewrite (`LaneSvg.svelte`) that classifies edges into three render categories (passthrough, continuation, curve) and draws them in z-order (rails, curves, dot). No changes to `CommitRow`, `CommitGraph`, `CommitCache`, or the IPC layer are required beyond threading the new fields through.

**Major components:**
1. **graph.rs (minor change)** -- Track `max_columns` and `is_branch_tip` during the existing walk
2. **types.rs/types.ts (minor change)** -- New `GraphResponse` wrapper struct and `is_branch_tip` field
3. **LaneSvg.svelte (full rewrite)** -- Edge classification, SVG path rendering (straights + Beziers + dot)
4. **CommitGraph/CommitRow (prop threading)** -- Pass `maxColumns` down to LaneSvg

### Critical Pitfalls

1. **Sub-pixel gaps between rows (#1, CRITICAL)** -- Draw lines from `y=-0.5` to `y=rowHeight+0.5` with `overflow: visible`. Use `stroke-width: 2` (even number) and `stroke-linecap: round`. Test at 100%, 110%, 125%, 150%, 200% zoom. This was likely the primary cause of v0.1's lane rendering failure.

2. **Inconsistent SVG width / jagged message alignment (#6, CRITICAL)** -- Use `max_columns * laneWidth` for ALL rows' SVG width instead of per-commit column width. The Rust algorithm returns this as page-level metadata. Consider setting width via CSS custom property `--graph-width` to avoid 40-component re-render storms (#8).

3. **Bezier curve misalignment at row boundaries (#2, CRITICAL)** -- Define each fork/merge curve as a single logical Bezier spanning the full row height. Source row draws from commit dot (y=MID) to row bottom (y=rowHeight). Destination row continues with a straight rail from its top. Do NOT attempt to split one curve across two independent SVGs with independent control points.

4. **Ghost lanes after merge (#4, CRITICAL)** -- Verify the Rust algorithm properly clears `active_lanes` slots after merges. Add dedicated test: after a merge, the merged branch's column must have NO `Straight` edge in subsequent rows. Check `pending_parents` interaction at line 145 of graph.rs for potential lane collision (#9).

5. **Pass-through edges not rendered (#10, CRITICAL)** -- The renderer must draw EVERY `Straight` edge from the Rust algorithm, including those where `from_column == to_column` and `from_column != commit.column`. These are active branch rails passing through the row. Missing these was likely a contributing factor to v0.1's visual bugs.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Lane Algorithm Hardening

**Rationale:** All frontend rendering depends on correct data from Rust. Fixing algorithm bugs after rendering code exists means debugging two layers simultaneously. This was likely a pain point in v0.1.
**Delivers:** Verified, tested lane algorithm with no ghost lanes, no lane collisions, correct octopus merge handling, and two new data fields (`max_columns`, `is_branch_tip`).
**Addresses:** T4 (lane packing verification), T7 (HEAD pinning verification), foundation for all rendering.
**Avoids:** Pitfalls #4 (ghost lanes), #5 (octopus explosion), #9 (lane collision).
**Scope:** Add `GraphResponse` struct, `is_branch_tip` field, `max_columns` tracking. Add test fixtures for octopus merges, nested merges, long-running branches. Add collision detection assertions. Update `CommitCache` and IPC types.

### Phase 2: SVG Rendering Foundation (Straight Rails)

**Rationale:** Straight vertical rails are the single biggest visual leap from "dots only" to "real graph." They exercise 80%+ of the rendering pipeline (SVG width, pass-through edges, z-ordering, row continuity) without the complexity of Bezier curves. This phase proves the per-row SVG approach works and catches the sub-pixel gap issue early.
**Delivers:** Continuous vertical lane rails through the entire graph, consistent SVG width, properly z-ordered commit dots. The graph immediately looks like a real git graph.
**Addresses:** T1 (vertical rails), T6 (pass-through lanes), T3 (color consistency visual verification), T5 (merge dot polish).
**Avoids:** Pitfalls #1 (sub-pixel gaps), #6 (SVG width inconsistency), #10 (missing pass-through edges), #13 (dot z-order).

### Phase 3: Bezier Curve Rendering

**Rationale:** Curves are the hardest per-row SVG rendering problem and should be isolated into their own phase so failures are easy to diagnose. With straight rails already working, adding curves is additive -- if curves break, you can revert without losing the rail progress.
**Delivers:** Smooth cubic Bezier fork/merge edges. The graph goes from "functional" to "GitKraken-quality."
**Addresses:** T2 (smooth curves).
**Avoids:** Pitfalls #2 (curve row-boundary misalignment), #11 (jagged curves at low stroke width).

### Phase 4: WIP Row and Polish

**Rationale:** With all commit rows rendering correctly, the WIP row integration and visual polish are incremental additions that bring the graph to release quality.
**Delivers:** WIP row connected to HEAD via dashed lane line, tuned lane width (12px to 16px), color palette accessibility fix for `--lane-7`, dimmed merge commits toggle.
**Addresses:** T8 (WIP row connection), D5 (dim merge commits), lane color accessibility (#12).
**Avoids:** Pitfall #16 (WIP not in lane graph), #12 (color palette contrast).

### Phase 5: Differentiator Features (optional for v0.2)

**Rationale:** These are polish features that elevate the graph from "functional" to "delightful." They are independent of each other and can ship in any order after the core rendering is solid.
**Delivers:** Ref label color connection, graph width control, re-render optimization via CSS variable.
**Addresses:** D2 (ref label connection), D4 (graph width control).
**Avoids:** Pitfall #8 (re-render storms from reactive width recalculation).

### Phase Ordering Rationale

- **Data before rendering:** Phases 1-2 ensure the Rust algorithm is battle-tested before the frontend consumes its output. This avoids the v0.1 failure mode of debugging algorithm bugs through rendering symptoms.
- **Rails before curves:** Phase 2 (straight lines) exercises the entire rendering pipeline with minimal geometry complexity. Phase 3 (curves) adds only the Bezier path computation without changing any other rendering infrastructure.
- **Core before polish:** Phases 1-3 deliver a fully functional graph. Phases 4-5 are refinement that can be cut from v0.2 scope if time is tight.
- **Pitfall-driven ordering:** Each phase explicitly addresses the pitfalls relevant to its scope, preventing the accumulation of visual bugs that killed v0.1.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** May need phase research for the `pending_parents` / `active_lanes` interaction that causes lane collisions (Pitfall #9). The current code analysis identified the risk but the fix needs careful validation against the actual algorithm logic.
- **Phase 3:** May need phase research for the Bezier control point factor. Research found 0.8 (vscode-git-graph) and 0.4 (DoltHub interpretation) -- these may describe the same thing differently (0.8 of half-row-height = 0.4 of full-row-height). Empirical tuning will be needed.

Phases with standard patterns (skip research-phase):
- **Phase 2:** Straight SVG line rendering is fully specified. The formulas, z-ordering, and sub-pixel gap fix are all documented with high confidence.
- **Phase 4:** WIP row integration and CSS polish are straightforward implementation tasks.
- **Phase 5:** Ref label coloring and graph width control are CSS/prop changes with no algorithmic complexity.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. SVG path commands are a web standard. Bezier formula verified from vscode-git-graph source code. |
| Features | MEDIUM-HIGH | Table stakes cross-referenced across GitKraken, Fork, Sourcetree, vscode-git-graph. Feature prioritization is clear. Minor uncertainty on optimal lane width (12px vs 16px). |
| Architecture | HIGH | Existing codebase deeply analyzed. Change surface is small (one component rewrite + minor Rust plumbing). Data flow verified against Git Extensions and react-commits-graph architectures. |
| Pitfalls | HIGH | 16 pitfalls identified with specific codebase line references. v0.1 failure modes reconstructed from code analysis. Prevention strategies verified against browser documentation and working implementations. |

**Overall confidence:** HIGH

### Gaps to Address

- **Bezier control point factor ambiguity:** Research found 0.8 (vscode-git-graph's `grid.y * 0.8`) and 0.4 (architecture doc's `rowHeight * 0.4`). These likely describe the same curve from different reference frames. Resolve empirically during Phase 3.
- **Lane width (12px vs 16px):** STACK.md uses 12px throughout; ARCHITECTURE.md recommends 16px. Start with 16px per architecture recommendation, adjust during Phase 2 based on visual appearance with real repo data.
- **WIP row synthetic node approach:** Either a synthetic WIP node in Rust or a frontend column calculation. The Rust approach is cleaner but touches more code. Decide during Phase 4 planning.
- **Lane collision fix specifics (Pitfall #9):** The secondary parent column assignment at graph.rs line 145 may collide with `pending_parents` reservations. Needs careful code analysis during Phase 1 to determine if the bug exists in practice or is only theoretical.

## Sources

### Primary (HIGH confidence)
- [vscode-git-graph source (graph.ts)](https://github.com/mhutchie/vscode-git-graph/blob/develop/web/graph.ts) -- Bezier formula (0.8 factor), rendering architecture
- [SVG Paths MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths) -- Cubic Bezier `C` command specification
- [SVG overflow MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/overflow) -- `overflow: visible` behavior
- [SVG shape-rendering MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/shape-rendering) -- `crispEdges` behavior
- [Mastering SVG Seams (junkangworld)](https://junkangworld.com/blog/mastering-svg-seams-5-pro-fixes-for-flawless-shapes-2025) -- Anti-aliasing gap prevention
- [Fix for gap between inline SVG elements](https://codepen.io/elliz/pen/dOOrxO) -- `display: block` fix
- Trunk codebase: `graph.rs`, `types.rs`, `LaneSvg.svelte`, `CommitRow.svelte`, `CommitGraph.svelte`, `state.rs`, `history.rs`

### Secondary (MEDIUM confidence)
- [DoltHub: Drawing a Commit Graph](https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/) -- Bezier control point interpolation, column assignment
- [pvigier: Commit Graph Drawing Algorithms](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html) -- Algorithm comparison, performance benchmarks
- [Git Extensions Revision Graph wiki](https://github.com/gitextensions/gitextensions/wiki/Revision-Graph) -- Per-row segment rendering architecture
- [GitKraken Commit Graph features page](https://www.gitkraken.com/features/commit-graph) -- Visual reference for target quality
- [vscode-git-graph issues #194, #254](https://github.com/mhutchie/vscode-git-graph/issues/194) -- Color/position mapping, maintainer explanations
- [SmartGit branch-line coloring discussion](https://smartgit.userecho.com/communities/1/topics/6-log-make-branch-line-coloring-easier-to-understand-sg-11160) -- Color assignment strategies

### Tertiary (LOW confidence)
- [Hacker News: graph algorithms discussion](https://news.ycombinator.com/item?id=21079643) -- Anecdotal tool comparisons
- [gitgraph.js paginated rendering issue #215](https://github.com/nicoespeon/gitgraph.js/issues/215) -- Bitbucket's block rendering approach
- [Codebase HQ: Building Commit Graphs](https://www.codebasehq.com/blog/building-commit-graphs) -- Row-based rendering with yStep spacing

---
*Research completed: 2026-03-09*
*Ready for roadmap: yes*
