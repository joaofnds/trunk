---
gsd_state_version: 1.0
milestone: v0.4
milestone_name: Graph Rework
status: in-progress
stopped_at: null
last_updated: "2026-03-12T19:00:00.000Z"
last_activity: 2026-03-12 — v0.4 roadmap created (5 phases, 12 requirements)
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-12)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Phase 15 - Graph Data Engine

## Current Position

Phase: 15 of 19 (Graph Data Engine) — first phase of v0.4
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-03-12 — v0.4 roadmap created

Progress: [░░░░░░░░░░] 0% (v0.4: 0/5 phases)

## Accumulated Context

### Decisions

- [v0.4]: ViewBox-clipped per-row SVGs over overlay approach (eliminates scroll sync, z-index issues)
- [v0.4]: Path generation in TypeScript, not Rust (Rust already returns all needed data)
- [v0.4]: Zero new dependencies -- architecture change only
- [v0.4]: Ref pills as SVG is highest risk -- tackle last, HTML fallback ready

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

Last session: 2026-03-12
Stopped at: v0.4 roadmap created, ready to plan Phase 15
Resume file: None
