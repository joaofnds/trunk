# Roadmap: Trunk

## Milestones

- ✅ **v0.1 MVP** — Phases 1-6 (shipped 2026-03-09)
- 🚧 **v0.2 Commit Graph** — Phases 7-11 (in progress)

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

### 🚧 v0.2 Commit Graph (In Progress)

**Milestone Goal:** GitKraken-quality commit graph with proper lane rendering -- vertical rails, smooth bezier curves, consistent lane colors, lane packing, and visual merge commit distinction.

- [ ] **Phase 7: Lane Algorithm Hardening** - Battle-tested Rust algorithm with correct data for all graph topologies
- [ ] **Phase 8: Straight Rail Rendering** - Continuous vertical lane lines through the entire commit graph
- [ ] **Phase 9: Bezier Curve Rendering** - Smooth merge/fork curves completing the GitKraken-quality graph shape
- [ ] **Phase 10: WIP Row + Visual Polish** - WIP lane connection and merge commit visual refinements
- [ ] **Phase 11: Differentiators** - Lane-colored ref pills and resizable graph column

## Phase Details

### Phase 7: Lane Algorithm Hardening
**Goal**: The Rust lane algorithm produces correct, complete data for every graph topology -- no ghost lanes, no column explosions, consistent widths
**Depends on**: Nothing (first v0.2 phase; builds on existing v0.1 algorithm)
**Requirements**: ALGO-01, ALGO-02, ALGO-03, LANE-05
**Success Criteria** (what must be TRUE):
  1. After a branch merges, its former lane column produces no edges in subsequent rows (no ghost lanes)
  2. An octopus merge (3+ parents) renders without the graph width growing beyond the number of actually active branches
  3. Every commit row SVG has the same width, and the commit message column does not jitter horizontally when scrolling
  4. Freed lane columns are reused by new branches, keeping the graph compact
**Plans**: TBD

### Phase 8: Straight Rail Rendering
**Goal**: Users see continuous vertical colored lines connecting commits in each branch, with all active lanes drawn through every row
**Depends on**: Phase 7
**Requirements**: LANE-01, LANE-03, LANE-04
**Success Criteria** (what must be TRUE):
  1. Each branch has a continuous vertical colored line from its tip commit to its base, with no gaps between rows at any zoom level
  2. Every commit row draws rails for all active branches passing through that row, not just the branch that owns the commit
  3. A branch maintains the same lane color from tip to base -- the color does not change or jump between commits
  4. Commit dots render on top of lane lines (not behind or clipped by them)
**Plans**: TBD

### Phase 9: Bezier Curve Rendering
**Goal**: Merge and fork points use smooth cubic Bezier curves instead of jagged diagonal lines
**Depends on**: Phase 8
**Requirements**: LANE-02
**Success Criteria** (what must be TRUE):
  1. When a branch merges, the connection from the source lane to the merge commit is a smooth S-curve, not a straight diagonal
  2. When a branch forks, the connection from the parent commit to the new lane is a smooth S-curve
  3. Curves align seamlessly at row boundaries -- no visible kink or offset where a curve crosses from one row SVG to the next
**Plans**: TBD

### Phase 10: WIP Row + Visual Polish
**Goal**: The graph distinguishes merge commits visually, connects the WIP row to HEAD, and reduces visual noise from merge commits
**Depends on**: Phase 9
**Requirements**: VIS-01, VIS-02, VIS-03
**Success Criteria** (what must be TRUE):
  1. Merge commits display as hollow circles with a lane-colored stroke, visually distinct from regular filled-circle commits
  2. When the working tree is dirty, the WIP row connects to the HEAD commit via a dashed lane line (not floating disconnected)
  3. Merge commits render with reduced opacity so the eye naturally focuses on regular work commits
**Plans**: TBD

### Phase 11: Differentiators
**Goal**: Branch/tag labels integrate visually with the graph, and users can control graph column width
**Depends on**: Phase 10
**Requirements**: DIFF-01, DIFF-02
**Success Criteria** (what must be TRUE):
  1. Branch and tag ref pills next to commit messages are colored to match their lane color in the graph
  2. User can drag a handle to resize the graph column width, and the new width persists across scrolling
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 7 -> 8 -> 9 -> 10 -> 11

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v0.1 | 3/3 | Complete | 2026-03-03 |
| 2. Repository Open + Commit Graph | v0.1 | 8/9 | Complete | 2026-03-09 |
| 3. Branch Sidebar + Checkout | v0.1 | 5/5 | Complete | 2026-03-04 |
| 4. Working Tree + Staging | v0.1 | 4/4 | Complete | 2026-03-07 |
| 5. Commit Creation | v0.1 | 3/3 | Complete | 2026-03-07 |
| 6. Diff Display | v0.1 | 3/3 | Complete | 2026-03-07 |
| 7. Lane Algorithm Hardening | v0.2 | 0/0 | Not started | - |
| 8. Straight Rail Rendering | v0.2 | 0/0 | Not started | - |
| 9. Bezier Curve Rendering | v0.2 | 0/0 | Not started | - |
| 10. WIP Row + Visual Polish | v0.2 | 0/0 | Not started | - |
| 11. Differentiators | v0.2 | 0/0 | Not started | - |
