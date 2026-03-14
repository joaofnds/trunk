---
gsd_state_version: 1.0
milestone: v0.5
milestone_name: Graph Overlay
status: executing
stopped_at: Completed 20-02-PLAN.md
last_updated: "2026-03-14T02:15:35.164Z"
last_activity: 2026-03-14 — Phase 20 plan 1 complete (types, constants, vendored virtual list)
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-13)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** v0.5 Graph Overlay — Phase 20 (Foundation — Types, Constants & Overlay Container)

## Current Position

Phase: 20 — Foundation — Types, Constants & Overlay Container (in progress)
Plan: 01 (complete)
Status: In Progress
Last activity: 2026-03-14 — Phase 20 plan 1 complete (types, constants, vendored virtual list)

```
v0.5 Graph Overlay
[░░░░░░░░░░░░░░░░░░░░] 0/7 phases (14% complete - 1/1 plans in phase 20)
```

## Performance Metrics

| Metric | v0.1 | v0.2 | v0.3 | v0.4 | v0.5 |
|--------|------|------|------|------|------|
| Phases | 6 | 4 | 4 | 3 | 7 |
| Plans | 27 | 9 | 14 | 5 | TBD |
| Commits | 155 | 76 | 88 | ~30 | — |
| Phase 20-foundation-types-constants-overlay-container P02 | 2min | 2 tasks | 1 files |

## Accumulated Context

### Decisions

- [v0.4]: ViewBox-clipped per-row SVGs over overlay approach (eliminates scroll sync, z-index issues)
- [v0.4]: Path generation in TypeScript, not Rust (Rust already returns all needed data)
- [v0.4]: Zero new dependencies -- architecture change only
- [v0.4]: Ref pills as SVG is highest risk -- tackle last, HTML fallback ready
- [v0.5]: Reverse "no full-height SVG" decision — single overlay enables continuous bezier paths
- [v0.5]: Rust lane algorithm stays, TS Active Lanes transformation bridges to global grid coords
- [v0.5]: Phase 20 is decision gate — if overlay fails, fallback to enhanced per-row viewBox
- [v0.5]: Phases 21 (Active Lanes) and 22 (Bezier Builder) can execute in parallel
- [v0.5]: SVG Ref Pills last (Phase 26) — highest risk, HTML fallback ready
- [20-01]: OVERLAY_DOT_RADIUS = 4 (25% of 16px lane) per user preference for smaller relative dots
- [20-01]: overlaySnippet placed before items div in DOM, receives contentHeight for SVG sizing
- [15-01]: Absolute Y coordinates based on row index for viewBox clipping compatibility
- [15-01]: Sentinel OID filtering via startsWith('__') prefix check
- [15-01]: Added vitest as test infrastructure (zero new runtime dependencies)
- [15-02]: graphSvgData placed after displayItems for clear dependency ordering
- [15-02]: Svelte 5 lazy $derived.by() means zero performance cost until Phase 16
- [16-01]: Reactive context via getter object pattern for Svelte 5 (setContext wraps Map in getter)
- [16-01]: Path categorization by key substring (:straight:/:rail: vs others) for linecap styling
- [17-01]: Extracted buildSentinelConnector helper to DRY connector path creation between WIP and stash
- [17-01]: WIP uses continue (no edge fall-through), stash falls through for pass-through edge processing
- [17-02]: Three-layer dot rendering: WIP (hollow dashed circle) → stash (filled square) → merge (hollow circle) → normal (filled circle)
- [17-02]: Stash entries interleaved after parent commit in displayItems, orphan stashes placed near top
- [17-02]: LaneSvg import removed from CommitRow but file preserved for reference

### Pending Todos

4 pending todos carried from v0.2:
1. **Make commit dot bigger and lanes thinner** (ui) — 2026-03-10
2. **WIP HEAD row background covers dotted line on hover** (ui) — 2026-03-10
3. **Second commit connector line disconnected from first commit** (ui) — 2026-03-10
4. **Persist left and right pane open/close state** (ui) — 2026-03-10

### Known Limitations

- SSH_AUTH_SOCK absent when app launched from Finder (not `cargo tauri dev`). Documented as known limitation.

### Blockers/Concerns

- [Research]: WebKit SVG performance at scale unverified -- must profile in production build
- [Research]: Ref pill "+N" hover-expand in SVG is unproven -- may need HTML fallback
- [Phase 20]: Decision gate — SVG-inside-virtual-list must be validated before investing in data/rendering

## Session Continuity

Last session: 2026-03-14T02:11:58.495Z
Stopped at: Completed 20-02-PLAN.md
Resume file: None
