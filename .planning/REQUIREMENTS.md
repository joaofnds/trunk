# Requirements: Trunk v0.2 Commit Graph

**Defined:** 2026-03-09
**Core Value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## v0.2 Requirements

Requirements for GitKraken-quality commit graph lane rendering. Each maps to roadmap phases.

### Lane Rendering

- [ ] **LANE-01**: User sees continuous vertical colored lines connecting commits in the same branch
- [ ] **LANE-02**: User sees smooth bezier curves when branches merge or fork (not jagged diagonals)
- [ ] **LANE-03**: User sees all active branch lanes drawn through every commit row, not just that branch's own commits
- [ ] **LANE-04**: User sees consistent lane colors per branch from tip to base (color does not jump between commits)
- [ ] **LANE-05**: User sees a compact graph where freed columns are reclaimed after branch merges

### Graph Algorithm

- [ ] **ALGO-01**: Lane algorithm produces no ghost lanes (cleared lanes must not render in subsequent rows)
- [ ] **ALGO-02**: Lane algorithm handles octopus merges (3+ parents) without graph width explosion
- [ ] **ALGO-03**: All commit rows have consistent SVG width based on max active columns (no message column jitter)

### Visual Polish

- [ ] **VIS-01**: User can visually distinguish merge commits from regular commits (hollow circle with lane-colored stroke)
- [ ] **VIS-02**: User sees a dashed lane line connecting the WIP row to the HEAD commit
- [ ] **VIS-03**: User sees merge commits rendered with reduced opacity to focus on actual work commits

### Differentiators

- [ ] **DIFF-01**: User sees branch/tag ref pills colored to match their lane color
- [ ] **DIFF-02**: User can resize the graph column width via drag handle

## Future Requirements

Deferred to v0.3+. Tracked but not in current roadmap.

### Graph Enhancements

- **GRAPH-01**: Crossing-lane detection with visual offset (gap or bridge when edges cross)
- **GRAPH-02**: Collapsible merge trains (expand/collapse merge commit child chains)
- **GRAPH-03**: Branch-specific color overrides (user assigns fixed colors to branch names)
- **GRAPH-04**: Animated edge transitions on graph redraw (smooth rather than jump)

### Interaction

- **INTER-01**: Keyboard navigation within graph (arrow keys to move commit selection)
- **INTER-02**: Author avatars on commit nodes (Gravatar)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Canvas-based graph rendering | Per-row inline SVG works with virtual scrolling, accessibility, text selection; Canvas would require complete rewrite |
| Single-SVG graph column | Defeats virtual scrolling; memory grows with commit count |
| Octopus merge fan rendering | Rare in practice; treat as multiple binary merge edges |
| Global crossing minimization | NP-hard (Sugiyama); greedy single-pass O(n) is good enough |
| Horizontal graph scrolling | Indicates too many branches; fix with lane packing + compact mode instead |
| 3D/perspective graph views | Universally less readable than 2D |
| Real-time graph streaming | 5ms for 10k commits makes batch computation sufficient |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| LANE-01 | — | Pending |
| LANE-02 | — | Pending |
| LANE-03 | — | Pending |
| LANE-04 | — | Pending |
| LANE-05 | — | Pending |
| ALGO-01 | — | Pending |
| ALGO-02 | — | Pending |
| ALGO-03 | — | Pending |
| VIS-01 | — | Pending |
| VIS-02 | — | Pending |
| VIS-03 | — | Pending |
| DIFF-01 | — | Pending |
| DIFF-02 | — | Pending |

**Coverage:**
- v0.2 requirements: 13 total
- Mapped to phases: 0
- Unmapped: 13 ⚠️

---
*Requirements defined: 2026-03-09*
*Last updated: 2026-03-09 after initial definition*
