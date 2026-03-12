---
gsd_state_version: 1.0
milestone: v0.4
milestone_name: Graph Rework
status: completed
stopped_at: Completed 15-02-PLAN.md (Phase 15 complete)
last_updated: "2026-03-12T18:55:55.485Z"
last_activity: 2026-03-12 — Completed 15-02 reactive graph data wiring
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-12)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Phase 15 - Graph Data Engine

## Current Position

Phase: 15 of 19 (Graph Data Engine) — first phase of v0.4
Plan: 2 of 2 in current phase (COMPLETE)
Status: Phase 15 complete
Last activity: 2026-03-12 — Completed 15-02 reactive graph data wiring

Progress: [██████████] 100% (v0.4: 1/5 phases, 2/2 plans in phase 15)

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

Last session: 2026-03-12T18:55:55.482Z
Stopped at: Completed 15-02-PLAN.md (Phase 15 complete)
Resume file: None
