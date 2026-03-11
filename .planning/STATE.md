---
gsd_state_version: 1.0
milestone: v0.3
milestone_name: Actions
status: defining_requirements
stopped_at: —
last_updated: "2026-03-10T00:00:00.000Z"
last_activity: 2026-03-10 — Milestone v0.3 Actions started
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-10)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Defining requirements for v0.3 Actions

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-03-10 — Milestone v0.3 Actions started

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v0.1]: Lanes removed, dots only for v0.1 -- v0.1 lane rendering had visual bugs; dedicated v0.2 milestone for graph
- [v0.2 research]: Sub-pixel gaps between row SVGs were likely the v0.1 failure cause -- use overflow:visible with 0.5px overlap
- [07-01]: Ghost lane test asserts on root commit (always processed last) rather than sibling commits with non-deterministic walk order
- [07-01]: Merge edges use source (merged-in) branch color; callers extract .commits from GraphResult (full GraphResult storage deferred to 07-02)
- [Phase 07-02]: GraphResponse IPC struct wraps commits slice + max_columns at command boundary; LaneSvg uses Math.max(maxColumns, column+1) as defensive guard
- [Phase 08]: [08-01]: Three-layer SVG rendering (rails -> edges -> dots) with Manhattan routing and 0.5px overlap for sub-pixel gap prevention
- [Phase 08]: [08-01]: Vivid GitHub-dark-inspired 8-color palette replacing low-contrast originals; commit dot uses color_index (not column)
- [Phase 09]: WIP synthetic item uses sentinel oid '__wip__' rather than extending GraphCommit type
- [Phase 09]: Hollow merge dot uses fill=var(--color-bg) to hide rail line; unused .wip-row CSS removed
- [Phase 10-01]: RefLabel.color_index set from commit color_index during graph output assembly; inline styles for dynamic lane colors
- [Phase 10-01]: Remote-only detection: RemoteBranch with no sibling LocalBranch or Tag on same commit
- [Phase 10-02]: Message column flex-1 absorbs remaining space; column widths persist on mouseup only to avoid excessive store writes
- [Phase 10-02]: Graph column min-width enforces maxColumns * laneWidth to prevent SVG clipping
- [Phase 10-03]: Connector line moved from LaneSvg SVG to CommitRow absolute div to span across ref and graph column boundaries
- [Phase 10-03]: Graph column overflow-hidden removed to allow WIP dotted line SVG overflow to extend into next row
- [Phase 10-04]: Connector line left offset uses 8px (row padding) + measured refContainerWidth via bind:clientWidth for precise positioning after pills
- [Phase 10-04]: Column dividers use inline border-right style rather than pseudo-elements for simplicity and consistency
- [Phase 10-05]: ColumnVisibility follows same LazyStore pattern as ColumnWidths; Message column locked as always-visible
- [Phase 10-05]: Connector line hidden with ref column since it spans from pills to graph dot
- [v0.3]: Remote ops will shell out to git CLI (not git2) per established decision for SSH/HTTPS reliability

### Pending Todos

4 pending todos carried from v0.2:
1. **Make commit dot bigger and lanes thinner** (ui) -- 2026-03-10
2. **WIP HEAD row background covers dotted line on hover** (ui) -- 2026-03-10
3. **Second commit connector line disconnected from first commit** (ui) -- 2026-03-10
4. **Persist left and right pane open/close state** (ui) -- 2026-03-10

### Blockers/Concerns

None yet.
