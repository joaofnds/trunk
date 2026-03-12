---
gsd_state_version: 1.0
milestone: v0.3
milestone_name: Actions
status: in-progress
stopped_at: Completed 13-03 UAT gap closure
last_updated: "2026-03-12T14:21:02.755Z"
last_activity: 2026-03-12 — Completed plan 13-03 UAT gap closure
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 11
  completed_plans: 11
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-10)

**Core value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits -- all without touching the terminal.
**Current focus:** Phase 13 — Remote Operations (complete)

## Current Position

Phase: 13 of 14 (Remote Operations)
Plan: 3 of 3 in current phase (complete)
Status: in-progress
Last activity: 2026-03-12 — Completed plan 13-03 UAT gap closure

Progress: [██████████] 100%

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
| Phase 11-stash-operations P04 | 3min | 2 tasks | 7 files |
| Phase 11-stash-operations P06 | 2min | 1 tasks | 1 files |
| Phase 11-stash-operations P05 | 2min | 1 tasks | 2 files |
| Phase 12-commit-context-menu P01 | 6min | 2 tasks | 8 files |
| Phase 12-commit-context-menu P02 | 4min | 1 tasks | 4 files |
| Phase 13-remote-operations P01 | 4min | 2 tasks | 5 files |
| Phase 13-remote-operations P02 | 2min | 1 tasks | 5 files |
| Phase 13-remote-operations P03 | 1min | 2 tasks | 2 files |

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
- [Phase 11-04]: Reuse handleCommitSelect for stash diff viewing — stashes are commits, diff_commit/commit_detail accept any OID
- [Phase 11-06]: Removed onrefreshed from stash handlers only -- branch handlers still need explicit callback since they don't emit repo-changed
- [Phase 11-stash-operations]: Use $derived.by() instead of IIFE pattern for displayItems stash injection -- cleaner Svelte 5 syntax
- [Phase 12-01]: Duplicated open_repo/is_dirty helpers in commit_actions.rs to avoid cross-module dependencies
- [Phase 12-01]: cherry_pick and revert use git CLI subprocess (not git2) with GIT_TERMINAL_PROMPT=0 for conflict detection
- [Phase 12-01]: create_branch dirty workdir check runs after branch creation but before checkout -- branch exists even if checkout fails
- [Phase 12-02]: InputDialog uses $state dialogConfig pattern -- set to show, null to hide
- [Phase 12-02]: WIP and stash rows excluded from commit context menu via oid.startsWith('__') guard
- [Phase 13-01]: Store child PID (u32) in RunningOp instead of tokio::process::Child because Child is !Sync
- [Phase 13-01]: Pass RunningOp inner mutex by reference to run_git_remote helper instead of using Tauri State in non-command functions
- [Phase 13-01]: Separate refresh_graph async helper for DRY graph rebuild across fetch/pull/push
- [Phase 13-02]: Shared $state rune in remote-state.svelte.ts for StatusBar/Toolbar communication instead of props/bindings
- [Phase 13-02]: Toolbar self-contains its own InputDialog for Branch -- keeps component independent
- [Phase 13-02]: Unicode symbols for toolbar button icons instead of SVG icons

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

Last session: 2026-03-12T14:14:24Z
Stopped at: Completed 13-03 UAT gap closure
Resume file: .planning/phases/13-remote-operations/13-03-SUMMARY.md
