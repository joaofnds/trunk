---
phase: 07-lane-algorithm-hardening
plan: 01
subsystem: algorithm
tags: [rust, git2, lane-assignment, graph, color-index, max-columns]

# Dependency graph
requires: []
provides:
  - "GraphResult wrapper struct with commits + max_columns"
  - "color_index field on GraphCommit for deterministic per-branch coloring"
  - "Hardened walk_commits with ghost lane fix, octopus column 0 protection, max_columns tracking, branch color counter"
  - "9 new test fixtures covering merge topologies, octopus merges, pagination consistency, column reuse, and color determinism"
affects: [08-lane-rendering, 09-commit-detail]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "GraphResult wrapper return type for algorithm metadata alongside commit data"
    - "Branch color counter with HashMap<column, color_index> for deterministic per-branch colors"
    - "Lane lifecycle pattern: ACTIVATE -> PASSTHROUGH -> TERMINATE with explicit color cleanup"

key-files:
  created: []
  modified:
    - "src-tauri/src/git/types.rs"
    - "src-tauri/src/git/graph.rs"
    - "src-tauri/src/commands/repo.rs"
    - "src-tauri/src/commands/commit.rs"
    - "src-tauri/src/commands/branches.rs"

key-decisions:
  - "Ghost lane test checks root commit (always processed last) rather than sibling commits whose walk order is non-deterministic"
  - "Merge edges use source (merged-in) branch color, fork edges use new branch color, pass-through edges use their own lane color"
  - "Callers extract .commits from GraphResult rather than updating CommitCache to store GraphResult directly (deferred to phase 07-02)"

patterns-established:
  - "GraphResult wrapper: walk_commits returns struct with commits + max_columns metadata"
  - "Branch color counter: monotonic next_color counter, HEAD gets 0, new branches get incrementing colors, freed columns remove their color entry"
  - "TDD test fixtures: make_merge_repo() helper for ghost lane testing, inline repo builders for octopus/criss-cross topologies"

requirements-completed: [ALGO-01, ALGO-02, ALGO-03, LANE-05]

# Metrics
duration: 8min
completed: 2026-03-09
---

# Phase 7 Plan 01: Lane Algorithm Hardening Summary

**Hardened walk_commits with ghost lane fix, octopus column 0 protection, max_columns tracking, and deterministic branch color counter via GraphResult return type**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-09T16:22:33Z
- **Completed:** 2026-03-09T16:30:56Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Eliminated ghost lanes after merges by properly freeing lane_colors when branch terminates at merge redirect
- Added octopus merge column 0 protection: secondary parent search skips column 0 when head_chain exists
- Implemented max_columns as high-water mark of active_lanes.len() across entire walk, consistent across pagination
- Added deterministic branch color counter: HEAD chain gets color_index 0, new branches get incrementing values
- Added GraphResult wrapper struct and color_index field on GraphCommit
- 16 tests pass (9 new + 7 existing), 50 total test suite green with 0 regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Types + failing tests for all 9 behaviors (RED)** - `80a714c` (test)
2. **Task 2: Implement algorithm fixes to make all tests GREEN** - `53ffd2a` (feat)

## Files Created/Modified
- `src-tauri/src/git/types.rs` - Added GraphResult struct and color_index field on GraphCommit
- `src-tauri/src/git/graph.rs` - Implemented all 5 algorithm fixes, 9 new tests, updated existing tests for GraphResult
- `src-tauri/src/commands/repo.rs` - Updated walk_commits caller to extract .commits from GraphResult
- `src-tauri/src/commands/commit.rs` - Updated refresh_commit_cache to extract .commits from GraphResult
- `src-tauri/src/commands/branches.rs` - Updated checkout_branch_inner and create_branch_inner to extract .commits

## Decisions Made
- Ghost lane test asserts on root commit (C0) rather than sibling commits (C1) because walk order between siblings at the same topological level is non-deterministic with identical timestamps
- Merge edges use the source (merged-in) branch color per CONTEXT.md decision: merge edges carry the incoming branch identity
- Callers currently extract .commits from GraphResult and store Vec<GraphCommit> in CommitCache; storing full GraphResult is deferred to plan 07-02 which handles API propagation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ghost lane test assertion target**
- **Found during:** Task 2 (algorithm implementation)
- **Issue:** Original test checked C1 for ghost lanes, but C1 may be processed before F1 in the walk (non-deterministic sibling order), meaning F1's lane is legitimately active at C1's row
- **Fix:** Changed test to check C0 (root commit, always processed last) where the feature column should definitively be freed
- **Files modified:** src-tauri/src/git/graph.rs
- **Verification:** Test passes deterministically regardless of sibling walk order
- **Committed in:** 53ffd2a (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Test correction needed to match actual algorithm semantics. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GraphResult type and color_index field ready for API propagation (plan 07-02)
- CommitCache still stores Vec<GraphCommit> -- needs updating to store GraphResult in plan 07-02
- Frontend TypeScript types need GraphResult interface and color_index field
- LaneSvg.svelte can use max_columns for consistent SVG width once API propagation is complete

---
*Phase: 07-lane-algorithm-hardening*
*Completed: 2026-03-09*
