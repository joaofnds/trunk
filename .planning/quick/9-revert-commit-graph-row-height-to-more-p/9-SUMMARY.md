---
phase: quick-9
plan: 9
subsystem: graph-constants
tags: [constants, layout, ui, tdd]
dependency_graph:
  requires: []
  provides: [ROW_HEIGHT=26, DOT_RADIUS=8, LANE_WIDTH=16]
  affects: [CommitGraph.svelte, CommitRow.svelte, overlay-paths.ts, ref-pill-data.ts]
tech_stack:
  added: []
  patterns: [TDD, single-source-of-truth constants]
key_files:
  modified:
    - src/lib/graph-constants.ts
    - src/lib/graph-constants.test.ts
    - src/lib/overlay-paths.test.ts
decisions:
  - ROW_HEIGHT reverted from 36 to 26 for compact commit history layout
  - DOT_RADIUS increased from 6 to 8 for larger, more visible commit dots
  - LANE_WIDTH kept at 16 (no change needed)
metrics:
  duration: 1min
  completed_date: "2026-03-14"
  tasks_completed: 1
  files_modified: 3
---

# Quick Task 9: Revert Commit Graph Row Height to More Compact Style — Summary

**One-liner:** Reverted ROW_HEIGHT from 36→26 (compact layout) and increased DOT_RADIUS from 6→8 (larger dots) with all 121 tests passing.

## What Was Done

Restored the denser, more compact commit history layout while retaining the wider 16px lanes from v0.5 overlay work. Commit dots are now 2px larger (radius 8 vs 6), making them more visually prominent in the tighter rows.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Update constants and fix all tests | 28e3c40 | graph-constants.ts, graph-constants.test.ts, overlay-paths.test.ts |

## Changes Made

### `src/lib/graph-constants.ts`
- `ROW_HEIGHT`: 36 → 26
- `DOT_RADIUS`: 6 → 8
- `LANE_WIDTH`: 16 (unchanged)

### `src/lib/graph-constants.test.ts`
- Updated `ROW_HEIGHT is 36` → `ROW_HEIGHT is 26`
- Updated `DOT_RADIUS is 6` → `DOT_RADIUS is 8`

### `src/lib/overlay-paths.test.ts`
- Updated mirror constant `ROW = 36` → `ROW = 26`
- Updated mirror constant `DOT_R = 6` → `DOT_R = 8`
- All path assertion math automatically correct via arithmetic locals

## Verification

```
Test Files  6 passed (6)
Tests      121 passed (121)
Duration   331ms
```

All tests pass. No regressions in any test file.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `src/lib/graph-constants.ts` exists with ROW_HEIGHT=26, DOT_RADIUS=8
- [x] `src/lib/graph-constants.test.ts` updated assertions
- [x] `src/lib/overlay-paths.test.ts` mirror constants updated
- [x] Commit 28e3c40 exists
- [x] Full test suite: 121/121 passing
