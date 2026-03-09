---
phase: 02-repository-open-commit-graph
plan: 08
subsystem: graph
tags: [git2, graph-algorithm, lane-assignment, fork-edges, column-priority]

# Dependency graph
requires:
  - phase: 02-repository-open-commit-graph
    provides: walk_commits lane algorithm, EdgeType enum, GraphEdge/GraphCommit types
provides:
  - HEAD-priority column 0 reservation in walk_commits
  - Correct ForkLeft/ForkRight edge topology for unmerged branch tips
  - Pre-computed head_chain HashSet for first-parent chain detection
affects: [02-repository-open-commit-graph, LaneSvg rendering]

# Tech tracking
tech-stack:
  added: []
  patterns: [head-chain pre-computation, pending_parents pre-population, column 0 reservation]

key-files:
  created: []
  modified: [src-tauri/src/git/graph.rs]

key-decisions:
  - "Pre-populate pending_parents for entire HEAD first-parent chain before walk loop to prevent branch tips from stealing column 0"
  - "Non-HEAD new chains skip column 0 in lane search to keep main line visually primary"
  - "Re-occupy active_lanes on same-column first-parent continuation to maintain pass-through edges"

patterns-established:
  - "HEAD chain pre-reservation: compute first-parent chain via parent_id(0) walk, insert all into pending_parents at col 0 before main revwalk loop"

requirements-completed: [GRAPH-02]

# Metrics
duration: 2min
completed: 2026-03-09
---

# Phase 02 Plan 08: Branch Fork Topology Summary

**HEAD-priority column 0 reservation with pre-populated pending_parents ensures branch lanes fork correctly from main line**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-09T03:39:19Z
- **Completed:** 2026-03-09T03:42:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 1

## Accomplishments
- HEAD's first-parent chain now always occupies column 0 regardless of revwalk visit order
- Branch tips are assigned to columns > 0 and emit ForkLeft edges toward column 0
- Pass-through edges maintained correctly via active_lanes re-occupation on same-column continuation
- All 7 graph tests pass (6 existing + 1 new branch_fork_topology)

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add failing branch_fork_topology test** - `62ac65e` (test)
2. **Task 1 (GREEN): HEAD-priority column assignment and branch fork topology** - `7771bd4` (feat)

_TDD task with RED/GREEN commits._

## Files Created/Modified
- `src-tauri/src/git/graph.rs` - Added head_chain pre-computation, pending_parents pre-population, column 0 skip for non-HEAD chains, active_lanes re-occupation, and branch_fork_topology test

## Decisions Made
- Pre-populate pending_parents for entire HEAD first-parent chain before walk loop -- prevents branch tips from claiming column 0 via their parent reservations
- Non-HEAD new chains start lane search at column 1 (skip column 0) to keep main line visually primary
- Re-occupy active_lanes[col] with parent_oid when first-parent is already pending at same column -- fixes pass-through edge continuity for intermediate rows

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Branch fork topology is now correct for unmerged branches
- LaneSvg.svelte already renders ForkLeft/ForkRight as Bezier curves, so the visual fix is immediate
- Ready for visual UAT verification of branch lane rendering

## Self-Check: PASSED

- FOUND: src-tauri/src/git/graph.rs
- FOUND: 02-08-SUMMARY.md
- FOUND: 62ac65e (test commit)
- FOUND: 7771bd4 (feat commit)

---
*Phase: 02-repository-open-commit-graph*
*Completed: 2026-03-09*
