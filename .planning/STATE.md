---
gsd_state_version: 1.0
milestone: v0.4
milestone_name: Graph Rework
status: in-progress
stopped_at: Completed 16-01 core graph rendering
last_updated: "2026-03-12T19:46:50.780Z"
last_activity: 2026-03-12 — Completed 16-01 core graph rendering
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 3
  completed_plans: 3
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-12)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Phase 16 - Core Graph Rendering

## Current Position

Phase: 16 of 19 (Core Graph Rendering) — second phase of v0.4
Plan: 1 of 1 in current phase (COMPLETE)
Status: Phase 16 plan 01 complete
Last activity: 2026-03-12 — Completed 16-01 core graph rendering

Progress: [██████████] 100% (v0.4: 2/5 phases, 3/3 plans complete)

## Accumulated Context

### Decisions

- [v0.4]: ViewBox-clipped per-row SVGs over overlay approach (eliminates scroll sync, z-index issues)
- [v0.4]: Path generation in TypeScript, not Rust (Rust already returns all needed data)
- [v0.4]: Zero new dependencies -- architecture change only
- [v0.4]: Ref pills as SVG is highest risk -- tackle last, HTML fallback ready
- [15-01]: Absolute Y coordinates based on row index for viewBox clipping compatibility
- [15-01]: Sentinel OID filtering via startsWith('__') prefix check
- [15-01]: Added vitest as test infrastructure (zero new runtime dependencies)
- [15-02]: graphSvgData placed after displayItems for clear dependency ordering
- [15-02]: Svelte 5 lazy $derived.by() means zero performance cost until Phase 16
- [16-01]: Reactive context via getter object pattern for Svelte 5 (setContext wraps Map in getter)
- [16-01]: Path categorization by key substring (:straight:/:rail: vs others) for linecap styling

### Pending Todos

4 pending todos carried from v0.2:
1. **Make commit dot bigger and lanes thinner** (ui) — 2026-03-10
2. **WIP HEAD row background covers dotted line on hover** (ui) — 2026-03-10
3. **Second commit connector line disconnected from first commit** (ui) — 2026-03-10
4. **Persist left and right pane open/close state** (ui) — 2026-03-10

### Known Limitations

- SSH_AUTH_SOCK absent when app launched from Finder (not `cargo tauri dev`). Documented as known limitation.

### Blockers/Concerns

- [Research]: WebKit SVG performance at scale unverified -- must profile Phase 16 in production build
- [Research]: Ref pill "+N" hover-expand in SVG is unproven -- Phase 18 may need HTML fallback

## Session Continuity

Last session: 2026-03-12T19:46:12Z
Stopped at: Completed 16-01 core graph rendering
Resume file: .planning/phases/16-core-graph-rendering/16-01-SUMMARY.md
