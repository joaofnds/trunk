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

## Future Requirements

### v0.5 — UI Polish & Quick Wins

- **UI-01**: Add icon set and use throughout the application
- **UI-02**: Find a better icon for the tag pill
- **UI-03**: Discard changes action
- **UI-04**: Branch delete action
- **UI-05**: Tag delete action
- **UI-06**: Check out branch after creating
- **UI-07**: Dialog system for errors/warnings/updates (replace all current error/warning handling)
- **UI-08**: Staging panel green/red buttons for stage all/unstage all
- **UI-09**: Equal height for unstaged and staged file lists when not collapsed
- **UI-10**: Three-way commit selector (commit / amend / stash)
- **UI-11**: Add small padding to top and bottom of commit graph
- **UI-12**: Graph overflow — shrinkable graph column with sticky right-side commits, single-line dot mode like GitKraken
- **UI-13**: File list view toggle (list vs preview, everywhere file lists are shown)
- **BUG-01**: Branch overflow pill is behind the commit graph (z-index)
- **BUG-02**: Graph column header has trailing divider when no columns follow

### v0.6 — Hunk Staging & Search

- **HUNK-01**: Stage/unstage individual hunks
- **SEARCH-01**: Search for commit hashes, commit messages, and branches on the commit graph with cmd+f

### v0.7 — Conflict & Rebase

- **CONFLICT-01**: Conflict diffs
- **CONFLICT-02**: Conflict resolution
- **REBASE-01**: Interactive rebase

### v0.8 — Multi-tab

- **TAB-01**: Multiple functional tabs

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
