# Roadmap: Trunk

## Milestones

- ✅ **v0.1 MVP** — Phases 1-6 (shipped 2026-03-09)
- ✅ **v0.2 Commit Graph** — Phases 7-10 (shipped 2026-03-10)
- ✅ **v0.3 Actions** — Phases 11-14 (shipped 2026-03-12)
- 🚧 **v0.4 Graph Rework** — Phases 15-19 (in progress)

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

### v0.4 Graph Rework (In Progress)

**Milestone Goal:** Replace per-row SVG rendering with continuous SVG paths -- one `<path>` per commit-to-commit edge, viewBox-clipped per row. Visuals stay identical; architecture eliminates row-boundary rendering bugs.

- [ ] **Phase 15: Graph Data Engine** - Compute continuous SVG path data from commit graph
- [ ] **Phase 16: Core Graph Rendering** - Render viewBox-clipped SVG paths with commit dots
- [ ] **Phase 17: Synthetic Row Adaptation** - Adapt WIP and stash rows to new SVG model
- [ ] **Phase 18: Ref Pill Migration** - Migrate ref pills and connectors to SVG elements
- [ ] **Phase 19: Interaction Preservation** - Preserve all click and context menu interactions

## Phase Details

### Phase 15: Graph Data Engine
**Goal**: Users see no change yet, but the data layer computes one continuous SVG path per commit-to-commit edge ready for rendering
**Depends on**: Nothing (first phase of v0.4)
**Requirements**: GRAPH-01
**Success Criteria** (what must be TRUE):
  1. `GraphSvgData` produces one SVG `<path>` d-string per commit-to-commit edge (parent links and merge/fork edges)
  2. Manhattan routing is preserved in generated path strings (horizontal + arc + vertical segments)
  3. Path data recomputes only on data change (not on scroll), verified by reactive `$derived.by()` pattern
**Plans**: TBD

Plans:
- [ ] 15-01: TBD

### Phase 16: Core Graph Rendering
**Goal**: The commit graph renders using viewBox-clipped continuous SVG paths with zero visual difference from v0.3
**Depends on**: Phase 15
**Requirements**: RENDER-01, RENDER-02, RENDER-03
**Success Criteria** (what must be TRUE):
  1. Each visible graph row renders a viewBox-clipped band of the full SVG paths with no per-row seams
  2. Commit dots render as filled circles for regular commits and hollow circles for merge commits
  3. The graph is visually identical to v0.3 output (same colors, same routing, same dot styles, same lane positions)
  4. Virtual scrolling remains smooth at 60fps with large repos (5k+ commits)
**Plans**: TBD

Plans:
- [ ] 16-01: TBD

### Phase 17: Synthetic Row Adaptation
**Goal**: WIP and stash synthetic rows render correctly in the new SVG model
**Depends on**: Phase 16
**Requirements**: SYNTH-01, SYNTH-02
**Success Criteria** (what must be TRUE):
  1. WIP row displays with a dashed connector line to the HEAD commit dot
  2. Stash rows display with square dots and dashed connector lines
  3. Synthetic rows integrate with virtual scrolling without visual artifacts
**Plans**: TBD

Plans:
- [ ] 17-01: TBD

### Phase 18: Ref Pill Migration
**Goal**: Ref pills and their connectors render as SVG elements with all existing behaviors preserved
**Depends on**: Phase 16
**Requirements**: REF-01, REF-02, REF-03
**Success Criteria** (what must be TRUE):
  1. Ref pills render as SVG elements (rect + text) with lane-colored backgrounds
  2. Ref connector lines render as single SVG paths from pill to commit dot
  3. Remote branch pills appear dimmed compared to local branch pills
  4. Overflow "+N" badge appears when refs exceed available space
**Plans**: TBD

Plans:
- [ ] 18-01: TBD

### Phase 19: Interaction Preservation
**Goal**: All existing click and context menu interactions work identically to v0.3
**Depends on**: Phase 16, Phase 17, Phase 18
**Requirements**: INTERACT-01, INTERACT-02, INTERACT-03
**Success Criteria** (what must be TRUE):
  1. Clicking a commit row selects it and shows commit detail in the diff panel
  2. Right-clicking a commit row opens the context menu with all actions (copy SHA, checkout, branch, tag, cherry-pick, revert)
  3. Right-clicking a stash row opens the stash context menu with pop/apply/drop actions
**Plans**: TBD

Plans:
- [ ] 19-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 15 -> 16 -> 17 -> 18 -> 19
Note: Phases 17 and 18 both depend on 16 but not each other. Phase 19 depends on all three.

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
| 15. Graph Data Engine | v0.4 | 0/? | Not started | - |
| 16. Core Graph Rendering | v0.4 | 0/? | Not started | - |
| 17. Synthetic Row Adaptation | v0.4 | 0/? | Not started | - |
| 18. Ref Pill Migration | v0.4 | 0/? | Not started | - |
| 19. Interaction Preservation | v0.4 | 0/? | Not started | - |
