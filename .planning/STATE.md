---
gsd_state_version: 1.0
milestone: v0.5
milestone_name: Graph Overlay
status: not_started
stopped_at: null
last_updated: "2026-03-13"
last_activity: 2026-03-13 — Milestone v0.5 started
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-13)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Defining requirements for v0.5 Graph Overlay

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-03-13 — Milestone v0.5 started

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

## Session Continuity

Last session: —
Stopped at: —
Resume file: None
