# Roadmap: Trunk

## Milestones

- ✅ **v0.1 MVP** — Phases 1-6 (shipped 2026-03-09)
- ✅ **v0.2 Commit Graph** — Phases 7-10 (shipped 2026-03-10)
- ✅ **v0.3 Actions** — Phases 11-14 (shipped 2026-03-12)
- ✅ **v0.4 Graph Rework** — Phases 15-17 (shipped 2026-03-13, phases 18-19 carried to v0.5)
- 🚧 **v0.5 Graph Overlay** — Phases 20-26 (in progress)

## Phases

<details>
<summary>✅ v0.1 MVP (Phases 1-6) — SHIPPED 2026-03-09</summary>

- [x] Phase 1: Foundation (3/3 plans) — completed 2026-03-03
- [x] Phase 2: Repository Open + Commit Graph (8/9 plans) — completed 2026-03-09
- [x] Phase 3: Branch Sidebar + Checkout (5/5 plans) — completed 2026-03-04
- [x] Phase 4: Working Tree + Staging (4/4 plans) — completed 2026-03-07
- [x] Phase 5: Commit Creation (3/3 plans) — completed 2026-03-07
- [x] Phase 6: Diff Display (3/3 plans) — completed 2026-03-07

Full details: [milestones/v0.1-ROADMAP.md](milestones/v0.1-ROADMAP.md)

</details>

<details>
<summary>✅ v0.2 Commit Graph (Phases 7-10) — SHIPPED 2026-03-10</summary>

- [x] Phase 7: Lane Algorithm Hardening (2/2 plans) — completed 2026-03-09
- [x] Phase 8: Straight Rail Rendering (1/1 plans) — completed 2026-03-09
- [x] Phase 9: WIP Row + Visual Polish (1/1 plans) — completed 2026-03-09
- [x] Phase 10: Differentiators (5/5 plans) — completed 2026-03-10

Full details: [milestones/v0.2-ROADMAP.md](milestones/v0.2-ROADMAP.md)

</details>

<details>
<summary>✅ v0.3 Actions (Phases 11-14) — SHIPPED 2026-03-12</summary>

- [x] Phase 11: Stash Operations (6/6 plans) — completed 2026-03-12
- [x] Phase 12: Commit Context Menu (2/2 plans) — completed 2026-03-12
- [x] Phase 13: Remote Operations (3/3 plans) — completed 2026-03-12
- [x] Phase 14: Toolbar + Tracking (3/3 plans) — completed 2026-03-12

Full details: [milestones/v0.3-ROADMAP.md](milestones/v0.3-ROADMAP.md)

</details>

<details>
<summary>✅ v0.4 Graph Rework (Phases 15-17) — SHIPPED 2026-03-13</summary>

- [x] Phase 15: Graph Data Engine (2/2 plans) — completed 2026-03-12
- [x] Phase 16: Core Graph Rendering (1/1 plans) — completed 2026-03-12
- [x] Phase 17: Synthetic Row Adaptation (2/2 plans) — completed 2026-03-13

Phases 18-19 (Ref Pill Migration, Interaction Preservation) carried into v0.5 as PILL-01–04 and INTR-01–03.

Full details: [milestones/v0.4-ROADMAP.md](milestones/v0.4-ROADMAP.md)

</details>

### v0.5 Graph Overlay (In Progress - 14%)

**Milestone Goal:** Replace per-row viewBox-clipped SVGs with a single SVG overlay architecture. Rust lane algorithm stays; TypeScript Active Lanes transformation bridges Rust output to global grid coordinates. Cubic bezier curves replace Manhattan routing. Ref pills migrate from HTML to SVG. All interactions preserved.

- [x] **Phase 20: Foundation — Types, Constants & Overlay Container** - Types, constants, vendored virtual list, SVG overlay POC complete (2/2 plans)
- [x] **Phase 21: Active Lanes Transformation** - Pure TS function transforming GraphCommit[] into GraphData with grid coordinates (completed 2026-03-14)
- [x] **Phase 22: Bezier Path Builder** - Cubic bezier curve generation and vertical rail path math (completed 2026-03-14)
- [ ] **Phase 23: SVG Rendering** - Three-layer GraphOverlay component with virtualized element rendering
- [ ] **Phase 24: Integration** - Wire overlay into CommitGraph, replace old pipeline, apply tuned dimensions
- [ ] **Phase 25: Interaction Preservation** - Preserve all click and context menu interactions through overlay
- [ ] **Phase 26: SVG Ref Pills** - Ref pills as SVG elements with connectors, dimming, and overflow

## Phase Details

### Phase 20: Foundation — Types, Constants & Overlay Container
**Goal**: The SVG overlay container is proven: a single SVG element sits inside the virtual list scroll container, scrolls natively with content, and passes all pointer events through to HTML rows beneath
**Depends on**: Nothing (first phase of v0.5)
**Requirements**: OVRL-01, OVRL-02, OVRL-03
**Status**: Complete (2/2 plans complete)
**Success Criteria** (what must be TRUE):
  1. A single `<svg>` element spans the full graph height inside the virtual list's scroll container
  2. The SVG scrolls in lockstep with commit rows — zero JS scroll sync code, purely native DOM scrolling
  3. Clicking and right-clicking commit rows beneath the SVG overlay fires all existing event handlers (pointer-events passthrough works)
  4. All new TypeScript types (`GraphNode`, `GraphEdge`, `GraphData`) and updated constants (`ROW_HEIGHT`, `LANE_WIDTH`, `DOT_RADIUS`) are defined and exported
**Plans:** 2/2 plans complete

Plans:
- [x] 20-01-PLAN.md — Types, constants & vendored virtual list with overlay slot
- [x] 20-02-PLAN.md — SVG overlay proof-of-concept & decision gate

**Decision Gate:** ✓ PASSED - Scroll sync and pointer passthrough verified

### Phase 21: Active Lanes Transformation
**Goal**: A pure TypeScript function transforms Rust's GraphCommit[] output into GraphData with integer grid coordinates, ready for SVG path generation
**Depends on**: Phase 20 (types)
**Requirements**: DATA-01, DATA-02
**Success Criteria** (what must be TRUE):
  1. `buildGraphData()` accepts `GraphCommit[]` and returns `GraphData` with `GraphNode[]` (x=swimlane, y=row) and `GraphEdge[]` (from/to coordinates with lane color)
  2. Edge coalescing merges consecutive same-lane straight segments — verified by unit test showing reduced edge count vs naive output
  3. WIP, stash, and all sentinel OID rows are correctly handled (filtered or transformed)
  4. Unit tests cover: linear history, branching, merging, octopus merge, WIP row, stash rows, empty input
**Plans:** 1/1 plans complete

Plans:
- [x] 21-01-PLAN.md — TDD: buildGraphData() with edge coalescing and sentinel handling

### Phase 22: Bezier Path Builder
**Goal**: SVG path `d` strings are generated for all edge types — cubic bezier for cross-lane connections and straight vertical lines for same-lane rails
**Depends on**: Phase 20 (types and constants)
**Requirements**: CURV-01, CURV-02, CURV-04
**Success Criteria** (what must be TRUE):
  1. Cross-lane edges produce SVG `C` command paths with vertical tangent control points (GitKraken-style waterfall curves)
  2. Same-lane connections produce continuous vertical `<path>` elements (one per lane run, not per row)
  3. Per-distance tension tuning produces smooth curves for adjacent rows (1-2 gap), nearby rows (3-5 gap), and distant rows (6+ gap) — no kinked diagonals
  4. Unit tests verify path `d` output for each distance tier and edge direction
**Plans:** 1/1 plans complete

Plans:
- [ ] 22-01-PLAN.md — TDD: buildOverlayPaths() with cubic bezier corners and rail generation

**Note:** Can be planned/executed in parallel with Phase 21 — both depend only on Phase 20 types.

### Phase 23: SVG Rendering
**Goal**: The GraphOverlay component renders commit dots, rails, and bezier edges as a three-layer SVG with virtualized element count
**Depends on**: Phase 21, Phase 22
**Requirements**: OVRL-04, CURV-03, DOTS-01, DOTS-02, DOTS-03
**Success Criteria** (what must be TRUE):
  1. SVG renders only visible-range elements plus buffer — hard cap on DOM node count regardless of total commits
  2. Three `<g>` groups enforce z-ordering: rails behind edges behind dots (no visual layering bugs)
  3. Normal commits render as filled circles, merge commits as hollow circles at correct lane positions
  4. WIP row renders with hollow dashed circle and dashed connector to HEAD
  5. Stash rows render with filled squares and dashed connectors
**Plans**: TBD

### Phase 24: Integration
**Goal**: The overlay replaces the old per-row SVG pipeline end-to-end — CommitGraph uses buildGraphData, CommitRow drops GraphCell, old files deleted, tuned dimensions visible
**Depends on**: Phase 23
**Requirements**: TUNE-01, TUNE-02
**Success Criteria** (what must be TRUE):
  1. Graph rows display at ~36px height (up from 26px) and lanes at ~16px width (up from 12px)
  2. All 8 lane colors from the vivid palette render via CSS custom properties on SVG elements
  3. Old rendering files deleted (`GraphCell.svelte`, `LaneSvg.svelte`, `graph-svg-data.ts`) — no dead code remains
  4. Virtual scrolling remains smooth with the overlay on repos with 5k+ commits
**Plans**: TBD

### Phase 25: Interaction Preservation
**Goal**: All click and context menu interactions from v0.3/v0.4 work identically through the overlay architecture
**Depends on**: Phase 24
**Requirements**: INTR-01, INTR-02, INTR-03
**Success Criteria** (what must be TRUE):
  1. Clicking a commit row selects it and shows commit detail in the diff panel
  2. Right-clicking a commit row opens the context menu with all actions (copy SHA/message, checkout, branch, tag, cherry-pick, revert)
  3. Right-clicking a stash row opens the stash context menu with pop/apply/drop actions
**Plans**: TBD

### Phase 26: SVG Ref Pills
**Goal**: Ref pills render as SVG elements with lane-colored backgrounds, connector lines, remote dimming, and overflow badges — replacing HTML ref pills in the graph column
**Depends on**: Phase 24
**Requirements**: PILL-01, PILL-02, PILL-03, PILL-04
**Success Criteria** (what must be TRUE):
  1. Ref pills render as SVG `<rect>` + `<text>` elements with lane-colored backgrounds matching branch color
  2. SVG connector lines render from each ref pill to its commit dot
  3. Remote branch pills appear visually dimmed compared to local branch pills
  4. An overflow "+N" badge appears when refs on a commit exceed available horizontal space
**Plans**: TBD

**Note:** Highest-risk SVG element — HTML fallback ready if SVG text layout limitations block delivery.

## Progress

**Execution Order:**
Phases 20 → 21 → 22 → 23 → 24 → 25 → 26
Phases 21 and 22 both depend on Phase 20 and can execute in parallel.
Phases 25 and 26 both depend on Phase 24 and can execute in parallel (but ref pills last per research).

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v0.1 | 3/3 | Complete | 2026-03-03 |
| 2. Repository Open + Commit Graph | v0.1 | 8/9 | Complete | 2026-03-09 |
| 3. Branch Sidebar + Checkout | v0.1 | 5/5 | Complete | 2026-03-04 |
| 4. Working Tree + Staging | v0.1 | 4/4 | Complete | 2026-03-07 |
| 5. Commit Creation | v0.1 | 3/3 | Complete | 2026-03-07 |
| 6. Diff Display | v0.1 | 3/3 | Complete | 2026-03-07 |
| 7. Lane Algorithm Hardening | v0.2 | 2/2 | Complete | 2026-03-09 |
| 8. Straight Rail Rendering | v0.2 | 1/1 | Complete | 2026-03-09 |
| 9. WIP Row + Visual Polish | v0.2 | 1/1 | Complete | 2026-03-09 |
| 10. Differentiators | v0.2 | 5/5 | Complete | 2026-03-10 |
| 11. Stash Operations | v0.3 | 6/6 | Complete | 2026-03-12 |
| 12. Commit Context Menu | v0.3 | 2/2 | Complete | 2026-03-12 |
| 13. Remote Operations | v0.3 | 3/3 | Complete | 2026-03-12 |
| 14. Toolbar + Tracking | v0.3 | 3/3 | Complete | 2026-03-12 |
| 15. Graph Data Engine | v0.4 | 2/2 | Complete | 2026-03-12 |
| 16. Core Graph Rendering | v0.4 | 1/1 | Complete | 2026-03-12 |
| 17. Synthetic Row Adaptation | v0.4 | 2/2 | Complete | 2026-03-13 |
| 20. Foundation — Types, Constants & Overlay Container | 2/2 | Complete    | 2026-03-14 | 2026-03-14 |
| 21. Active Lanes Transformation | v0.5 | 1/1 | Complete | 2026-03-14 |
| 22. Bezier Path Builder | 1/1 | Complete    | 2026-03-14 | - |
| 23. SVG Rendering | v0.5 | 0/? | Not started | - |
| 24. Integration | v0.5 | 0/? | Not started | - |
| 25. Interaction Preservation | v0.5 | 0/? | Not started | - |
| 26. SVG Ref Pills | v0.5 | 0/? | Not started | - |

---
*Roadmap created: 2026-03-13*
*Last updated: 2026-03-14 — Phase 21 complete*
