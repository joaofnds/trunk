# Requirements: Trunk

**Defined:** 2026-03-13
**Core Value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## v0.5 Requirements

Requirements for the Graph Overlay milestone. Replace per-row viewBox-clipped SVGs with a single SVG overlay architecture. Rust lane algorithm stays; TypeScript Active Lanes transformation bridges Rust output to global grid coordinates. Cubic bezier curves replace Manhattan routing. Ref pills migrate from HTML to SVG. All interactions preserved.

### Overlay Architecture

- [x] **OVRL-01**: Single SVG element spans entire graph height, positioned inside virtual list scroll container
- [x] **OVRL-02**: SVG overlay scrolls natively with virtual list content (zero JS scroll sync)
- [x] **OVRL-03**: SVG root has `pointer-events: none`, HTML commit rows handle all click/right-click interactions beneath
- [x] **OVRL-04**: SVG renders only visible-range elements plus buffer (virtualization), hard cap on DOM node count

### Data Transformation

- [x] **DATA-01**: TypeScript Active Lanes algorithm transforms `GraphCommit[]` into `GraphData` with `GraphNode[]` and `GraphEdge[]` containing integer grid coordinates (x=swimlane, y=row index)
- [x] **DATA-02**: Edge coalescing merges consecutive same-lane straight segments into single SVG path spans

### Curve Rendering

- [x] **CURV-01**: Cross-lane edges render as cubic bezier curves (SVG `C` command) with vertical tangent control points
- [x] **CURV-02**: Same-lane connections render as continuous vertical rail lines (one `<path>` per lane run)
- [x] **CURV-03**: SVG uses three-layer `<g>` group z-ordering: rails behind edges behind dots
- [x] **CURV-04**: Bezier control points use per-distance tension tuning (adaptive for adjacent vs distant row connections)

### Commit Dots & Synthetic Rows

- [x] **DOTS-01**: Normal commits render as filled circles, merge commits as hollow circles
- [x] **DOTS-02**: WIP row renders with hollow dashed circle and dashed connector to HEAD
- [x] **DOTS-03**: Stash rows render with filled squares and dashed connectors

### Ref Pills

- [x] **PILL-01**: Ref pills render as SVG `<rect>` + `<text>` elements with lane-colored backgrounds
- [x] **PILL-02**: SVG connector lines render from ref pill to commit dot
- [x] **PILL-03**: Remote branch pills appear visually dimmed compared to local branch pills
- [x] **PILL-04**: Overflow "+N" badge appears when refs exceed available space

### Interactions

- [x] **INTR-01**: Clicking a commit row selects it and shows commit detail in diff panel
- [x] **INTR-02**: Right-clicking a commit row opens context menu (copy SHA, checkout, branch, tag, cherry-pick, revert)
- [x] **INTR-03**: Right-clicking a stash row opens stash context menu (pop/apply/drop)

### Visual Tuning

- [x] **TUNE-01**: Updated graph dimensions: ROW_HEIGHT increased from 26px to ~36px, LANE_WIDTH from 12px to ~16px
- [x] **TUNE-02**: 8-color lane palette applied via CSS custom properties on SVG elements

## v0.4 Requirements (Completed/Superseded)

v0.4 introduced per-row viewBox-clipped SVG rendering. Phases 15-17 completed; phases 18-19 (ref pills, interactions) carried into v0.5 as PILL-01–04 and INTR-01–03.

### Graph Data

- [x] **GRAPH-01**: GraphSvgData computes one SVG `<path>` per commit-to-commit edge (parent links and merge/fork edges), each rendered as a single unbroken path with Manhattan routing where needed

### Core Rendering

- [x] **RENDER-01**: Each visible graph row renders a viewBox-clipped band of the full SVG paths (no per-row seams)
- [x] **RENDER-02**: Commit dots render as individual SVG elements (filled for regular, hollow for merges)
- [x] **RENDER-03**: Graph rendering produces identical visual output to v0.3

### Synthetic Rows

- [x] **SYNTH-01**: WIP row renders with dashed connector to HEAD in the new SVG model
- [x] **SYNTH-02**: Stash rows render with square dots and dashed connectors

### Ref Elements (Superseded by PILL-01–04)

- [ ] ~~**REF-01**: Ref pills render as SVG elements (rect + text) with lane-colored backgrounds~~ → PILL-01
- [ ] ~~**REF-02**: Ref connector lines render as single SVG paths from pill to commit dot~~ → PILL-02
- [ ] ~~**REF-03**: Ref pills maintain existing behavior (remote dimming, overflow "+N" badge)~~ → PILL-03, PILL-04

### Interaction (Superseded by INTR-01–03)

- [ ] ~~**INTERACT-01**: Clicking a commit row selects it and shows commit detail~~ → INTR-01
- [ ] ~~**INTERACT-02**: Right-clicking a commit row opens the context menu~~ → INTR-02
- [ ] ~~**INTERACT-03**: Right-clicking a stash row opens the stash context menu~~ → INTR-03

## Future Requirements

### v0.6 — UI Polish & Quick Wins

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

### v0.7 — Hunk Staging & Search

- **HUNK-01**: Stage/unstage individual hunks
- **SEARCH-01**: Search for commit hashes, commit messages, and branches on the commit graph with cmd+f

### v0.8 — Conflict & Rebase

- **CONFLICT-01**: Conflict diffs
- **CONFLICT-02**: Conflict resolution
- **REBASE-01**: Interactive rebase

### v0.9 — Multi-tab

- **TAB-01**: Multiple functional tabs

## Out of Scope

| Feature | Reason |
|---------|--------|
| Canvas rendering | SVG approach preserves accessibility and text selection; no need for Canvas |
| Hover-highlight on branch lines | Differentiator, deferred — overlay architecture enables it but not v0.5 scope |
| Click-to-select branch lines | Differentiator, deferred |
| D3.js / SVG.js / Snap.svg | Zero new dependencies needed — all capabilities are browser primitives |
| Ref pill hover-expand animation | Complex SVG text layout limitation — defer or simplify for v0.5 |
| Path draw-on animations | Differentiator, not essential for v0.5 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GRAPH-01 | Phase 15 | Complete |
| RENDER-01 | Phase 16 | Complete |
| RENDER-02 | Phase 16 | Complete |
| RENDER-03 | Phase 16 | Complete |
| SYNTH-01 | Phase 17 | Complete |
| SYNTH-02 | Phase 17 | Complete |
| OVRL-01 | Phase 20 | Complete |
| OVRL-02 | Phase 20 | Complete |
| OVRL-03 | Phase 20 | Complete |
| OVRL-04 | Phase 23 | Complete |
| DATA-01 | Phase 21 | Complete |
| DATA-02 | Phase 21 | Complete |
| CURV-01 | Phase 22 | Complete |
| CURV-02 | Phase 22 | Complete |
| CURV-03 | Phase 23 | Complete |
| CURV-04 | Phase 22 | Complete |
| DOTS-01 | Phase 23 | Complete |
| DOTS-02 | Phase 23 | Complete |
| DOTS-03 | Phase 23 | Complete |
| PILL-01 | Phase 26 | Complete |
| PILL-02 | Phase 26 | Complete |
| PILL-03 | Phase 26 | Complete |
| PILL-04 | Phase 26 | Complete |
| INTR-01 | Phase 25 | Complete |
| INTR-02 | Phase 25 | Complete |
| INTR-03 | Phase 25 | Complete |
| TUNE-01 | Phase 24 | Complete |
| TUNE-02 | Phase 24 | Complete |

**Coverage:**
- v0.5 requirements: 22 total
- Mapped to phases: 22/22 ✓
- Unmapped: 0

---
*Requirements defined: 2026-03-13*
*Last updated: 2026-03-14 — Phase 21 active lanes transformation complete*
