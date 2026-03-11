---
gsd_state_version: 1.0
milestone: v0.3
milestone_name: Actions
status: planning
stopped_at: Phase 12 context gathered
last_updated: "2026-03-11T23:35:08.878Z"
last_activity: 2026-03-10 — Roadmap created for v0.3 Actions (phases 11-14); 23/23 requirements mapped
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 3
  completed_plans: 3
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-10)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Phase 11 — Stash Operations

## Current Position

Phase: 11 of 14 (Stash Operations)
Plan: 0 of 3 in current phase
Status: Ready to plan
Last activity: 2026-03-10 — Roadmap created for v0.3 Actions (phases 11-14); 23/23 requirements mapped

Progress: [░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0 (v0.3)
- Average duration: — (no plans complete yet)
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| — | — | — | — |

*Updated after each plan completion*
| Phase 11-stash-operations P01 | 3 | 3 tasks | 5 files |
| Phase 11-stash-operations P02 | 3 | 2 tasks | 3 files |
| Phase 11-stash-operations P03 | 2min | 1 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [v0.3]: Remote ops will shell out to git CLI (not git2) per established decision for SSH/HTTPS reliability
- [v0.3 research]: Cherry-pick and revert also shell out to git CLI (avoid reimplementing conflict state machine)
- [v0.3 research]: `GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND=ssh -o BatchMode=yes` required on all subprocess env to prevent stdin blocking
- [v0.3 research]: Confirm `git2::Repository::stash_pop` exact signature on docs.rs before writing implementation (MEDIUM confidence on API surface)
- [v0.3 roadmap]: Stash list backend must return parent OID per entry so graph can position stash rows at correct commit
- [v0.3 roadmap]: Stash graph rendering is plan 11-02 — extends WIP sentinel pattern with square dots + dashed connectors; also owns STASH-07 right-click context menu on stash rows
- [v0.3 roadmap]: Stash sidebar UI is plan 11-03 — create form + pop/apply/drop actions (STASH-01, STASH-03, STASH-04, STASH-05, STASH-06)
- [Phase 11-01]: Two-pass stash OID resolution: stash_foreach collects (idx, name, *oid) Vec, parent resolution runs after foreach releases mutable borrow
- [Phase 11-01]: Block-scope pattern for Statuses drop: wrap repo.statuses() check in {} block before calling &mut repo function
- [Phase 11-01]: stash_pop/stash_apply check CONFLICTED status post-call because git2 may return Ok(()) even when conflicts occurred
- [Phase 11-stash-operations]: IIFE $derived(() => { ... })() pattern for displayItems enables imperative splice logic while keeping Svelte 5 reactivity
- [Phase 11-stash-operations]: Stash graph sentinel OID pattern: __stash_N__ prefix used to differentiate synthetic stash rows in LaneSvg dot layer
- [Phase 11-stash-operations]: Reuse BranchSection showCreateButton/oncreate props for stash '+' button — zero changes to BranchSection.svelte
- [Phase 11-stash-operations]: RefsResponse.stashes corrected from RefLabel[] to StashEntry[] — was missed in plan 11-02

### Pending Todos

4 pending todos carried from v0.2:
1. **Make commit dot bigger and lanes thinner** (ui) — 2026-03-10
2. **WIP HEAD row background covers dotted line on hover** (ui) — 2026-03-10
3. **Second commit connector line disconnected from first commit** (ui) — 2026-03-10
4. **Persist left and right pane open/close state** (ui) — 2026-03-10

### Blockers/Concerns

- [Phase 13 research flag]: Confirm `tokio::process::Command` stderr streaming pattern against Tauri 2 runtime version before writing remote commands. A proof-of-concept spike is recommended during Phase 13 planning.
- [Phase 13 known limitation]: SSH_AUTH_SOCK absent when app launched from Finder (not `cargo tauri dev`). Document as known limitation for v0.3; do not implement workaround.
- [Phase 14 open question]: Ahead/behind architecture decision (bundle into `list_refs` vs separate on-demand command) deferred to Phase 14 planning to avoid slowing sidebar refresh.

## Session Continuity

Last session: 2026-03-11T23:35:08.875Z
Stopped at: Phase 12 context gathered
Resume file: .planning/phases/12-commit-context-menu/12-CONTEXT.md
