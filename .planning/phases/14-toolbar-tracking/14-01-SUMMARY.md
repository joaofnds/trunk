---
phase: 14-toolbar-tracking
plan: 01
subsystem: ui
tags: [git2, graph_ahead_behind, svelte, branch-sidebar]

requires:
  - phase: 13-remote-operations
    provides: Remote fetch/pull/push that trigger repo-changed events refreshing refs
provides:
  - Real ahead/behind counts from git2 graph_ahead_behind in list_refs_inner
  - Arrow badge rendering in BranchRow for branches with remote tracking
affects: []

tech-stack:
  added: []
  patterns: [graph_ahead_behind for tracking divergence, conditional badge rendering]

key-files:
  created: []
  modified:
    - src-tauri/src/commands/branches.rs
    - src/components/BranchRow.svelte
    - src/components/BranchSidebar.svelte

key-decisions:
  - "Compute ahead/behind inside existing list_refs_inner map closure to avoid extra IPC round-trip"
  - "Use branch.upstream() second call inside match arm to get remote OID without double-borrow issues"

patterns-established:
  - "Arrow badge pattern: conditional span with flex-shrink:0 right-aligned in flex row"

requirements-completed: [TRACK-01, TRACK-02]

duration: 3min
completed: 2026-03-12
---

# Phase 14 Plan 01: Ahead/Behind Tracking Summary

**Real git2 graph_ahead_behind counts wired into branch sidebar with compact arrow badges**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-12T15:30:06Z
- **Completed:** 2026-03-12T15:33:21Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Replaced hardcoded ahead:0/behind:0 with real git2 graph_ahead_behind values for local branches with upstream tracking
- Added compact arrow badge rendering (down-arrow N, up-arrow N) to BranchRow, right-aligned
- Wired ahead/behind props from BranchSidebar to BranchRow for local branches
- Added test covering clone + local commit scenario verifying non-zero ahead count

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire real ahead/behind counts in list_refs_inner** - `a724bdc` (feat)
2. **Task 2: Add ahead/behind badges to BranchRow and wire in BranchSidebar** - `d40f296` (feat)

## Files Created/Modified
- `src-tauri/src/commands/branches.rs` - Real ahead/behind via graph_ahead_behind + new test
- `src/components/BranchRow.svelte` - Added ahead/behind props and arrow badge rendering
- `src/components/BranchSidebar.svelte` - Passes branch.ahead/behind to BranchRow

## Decisions Made
- Computed ahead/behind inside existing list_refs_inner map closure rather than a separate command, avoiding extra IPC round-trip
- Used second branch.upstream() call inside match arm to get remote OID, sidestepping borrow issues with local_oid extraction

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Ahead/behind counts are live and update via existing repo-changed event flow after fetch/pull/push
- All 84 cargo tests pass

## Self-Check: PASSED

All files exist. All commits verified.

---
*Phase: 14-toolbar-tracking*
*Completed: 2026-03-12*
