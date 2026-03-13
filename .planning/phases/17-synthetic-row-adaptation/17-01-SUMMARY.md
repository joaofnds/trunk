---
phase: 17-synthetic-row-adaptation
plan: 01
subsystem: graph
tags: [svg, path-generation, sentinel, wip, stash, dashed, tdd]

# Dependency graph
requires:
  - phase: 16-core-graph-rendering
    provides: computeGraphSvgData function and SvgPathData type
provides:
  - SvgPathData with optional dashed boolean flag
  - Sentinel connector path generation for WIP and stash rows
  - Key format {oid}:connector:{column} for sentinel paths
affects: [17-02-PLAN, 18-ref-pill-rendering]

# Tech tracking
tech-stack:
  added: []
  patterns: [sentinel-connector-path, dashed-flag-propagation, buildSentinelConnector-helper]

key-files:
  created: []
  modified:
    - src/lib/types.ts
    - src/lib/graph-svg-data.ts
    - src/lib/graph-svg-data.test.ts

key-decisions:
  - "Extracted buildSentinelConnector helper to DRY connector path creation between WIP and stash"
  - "WIP uses continue (no edge fall-through), stash falls through for pass-through edge processing"

patterns-established:
  - "Sentinel connector key format: {oid}:connector:{column}"
  - "dashed flag on SvgPathData for downstream renderer consumption"

requirements-completed: [SYNTH-01, SYNTH-02]

# Metrics
duration: 2min
completed: 2026-03-13
---

# Phase 17 Plan 01: Sentinel Path Generation Summary

**computeGraphSvgData generates dashed connector paths for WIP and stash sentinel rows with buildSentinelConnector helper, adding `dashed?: boolean` to SvgPathData**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-13T17:29:20Z
- **Completed:** 2026-03-13T17:32:09Z
- **Tasks:** 1 feature (TDD: RED → GREEN → REFACTOR)
- **Files modified:** 3

## Accomplishments
- SvgPathData interface extended with `dashed?: boolean` flag for downstream renderers
- computeGraphSvgData generates dashed connector paths for `__wip__` and `__stash_N__` rows instead of skipping them
- Stash pass-through edges (other lanes) processed normally and remain undashed
- All 21 tests pass (14 existing + 7 new sentinel tests, zero regressions)

## Task Commits

Each task was committed atomically:

1. **RED: Failing tests for sentinel path generation** - `86b03fd` (test)
2. **GREEN: Implement sentinel path generation** - `cc907ac` (feat)
3. **REFACTOR: Extract buildSentinelConnector helper** - `bf2f712` (refactor)

## Files Created/Modified
- `src/lib/types.ts` - Added `dashed?: boolean` to SvgPathData interface
- `src/lib/graph-svg-data.ts` - Sentinel connector path generation with buildSentinelConnector helper, DOT_RADIUS import
- `src/lib/graph-svg-data.test.ts` - 7 new tests for sentinel path behavior (WIP, stash, pass-through, non-sentinel)

## Decisions Made
- Extracted `buildSentinelConnector` helper to DRY connector path creation shared between WIP and stash
- WIP uses `continue` after connector (no edge fall-through needed), stash falls through for pass-through edge processing
- Stash own-column straight edge skipped (connector replaces it), other-lane edges processed normally

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Sentinel connector paths with `dashed: true` flag ready for Plan 02 (GraphCell rendering)
- Key format `{oid}:connector:{column}` established for downstream consumption
- Ready for 17-02: GraphCell dashed stroke-dasharray and differentiated dot shapes

## Self-Check: PASSED

All files verified on disk. All 3 commits verified in git history.

---
*Phase: 17-synthetic-row-adaptation*
*Completed: 2026-03-13*
