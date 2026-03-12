# Requirements: Trunk

**Defined:** 2026-03-12
**Core Value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## v0.4 Requirements

Requirements for the Graph Rework milestone. Replace per-row SVG rendering with continuous SVG paths — one `<path>` per commit-to-commit edge, viewBox-clipped per row. Visuals stay identical; architecture eliminates row-boundary rendering bugs.

### Graph Data

- [x] **GRAPH-01**: GraphSvgData computes one SVG `<path>` per commit-to-commit edge (parent links and merge/fork edges), each rendered as a single unbroken path with Manhattan routing where needed

### Core Rendering

- [x] **RENDER-01**: Each visible graph row renders a viewBox-clipped band of the full SVG paths (no per-row seams)
- [x] **RENDER-02**: Commit dots render as individual SVG elements (filled for regular, hollow for merges)
- [x] **RENDER-03**: Graph rendering produces identical visual output to v0.3

### Synthetic Rows

- [ ] **SYNTH-01**: WIP row renders with dashed connector to HEAD in the new SVG model
- [ ] **SYNTH-02**: Stash rows render with square dots and dashed connectors

### Ref Elements

- [ ] **REF-01**: Ref pills render as SVG elements (rect + text) with lane-colored backgrounds
- [ ] **REF-02**: Ref connector lines render as single SVG paths from pill to commit dot
- [ ] **REF-03**: Ref pills maintain existing behavior (remote dimming, overflow "+N" badge)

### Interaction

- [ ] **INTERACT-01**: Clicking a commit row selects it and shows commit detail
- [ ] **INTERACT-02**: Right-clicking a commit row opens the context menu
- [ ] **INTERACT-03**: Right-clicking a stash row opens the stash context menu

## Future Requirements (v0.5+)

### UI Polish

- **UI-01**: Add icon set and use throughout the application
- **UI-02**: Discard changes action
- **UI-03**: Stage/unstage individual hunks
- **UI-04**: Branch delete action
- **UI-05**: Tag delete action
- **UI-06**: Dialog system for errors/warnings/updates
- **UI-07**: Staging panel green/red buttons for stage all/unstage all
- **UI-08**: Equal height for unstaged and staged file lists when not collapsed
- **UI-09**: Three-way commit selector (commit / amend / stash)
- **UI-10**: Search commits/branches with cmd+f

### Advanced Git

- **GIT-01**: Interactive rebase
- **GIT-02**: Conflict diffs
- **GIT-03**: Conflict resolution
- **GIT-04**: Check out branch after creating
- **GIT-05**: Multiple tabs

## Out of Scope

| Feature | Reason |
|---------|--------|
| Canvas rendering | SVG approach preserves accessibility and text selection; no need for Canvas |
| Full-height single SVG (not clipped per row) | Research showed DOM explosion at scale; viewBox-clipped per row is the correct approach |
| Hover-highlight on branch lines | Differentiator, not part of "zero visual change" goal |
| Click-to-select branch lines | Differentiator, deferred |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GRAPH-01 | Phase 15 | Complete |
| RENDER-01 | Phase 16 | Complete |
| RENDER-02 | Phase 16 | Complete |
| RENDER-03 | Phase 16 | Complete |
| SYNTH-01 | Phase 17 | Pending |
| SYNTH-02 | Phase 17 | Pending |
| REF-01 | Phase 18 | Pending |
| REF-02 | Phase 18 | Pending |
| REF-03 | Phase 18 | Pending |
| INTERACT-01 | Phase 19 | Pending |
| INTERACT-02 | Phase 19 | Pending |
| INTERACT-03 | Phase 19 | Pending |

**Coverage:**
- v0.4 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-03-12*
*Last updated: 2026-03-12 after roadmap creation*
