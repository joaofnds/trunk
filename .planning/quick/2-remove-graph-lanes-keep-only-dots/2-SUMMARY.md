---
phase: quick
plan: 2
subsystem: commit-graph-ui
tags: [svelte, svg, graph-rendering, teardown]
dependency_graph:
  requires: []
  provides: [dot-only-graph-rendering]
  affects: [LaneSvg, CommitGraph-WIP-row]
tech_stack:
  added: []
  patterns: [dot-only-svg-rendering]
key_files:
  modified:
    - src/components/LaneSvg.svelte
    - src/components/CommitGraph.svelte
decisions:
  - Kept laneColor helper and cx/cy constants since they are still used by the commit dot
  - Left backend edge computation and TypeScript types unchanged per plan
metrics:
  duration_seconds: 67
  completed: "2026-03-09T04:44:56Z"
  tasks_completed: 1
  tasks_total: 1
---

# Quick Task 2: Remove Graph Lanes, Keep Only Dots - Summary

Stripped all SVG edge rendering (straight lines, Bezier fork/merge curves) from LaneSvg.svelte and the WIP row connecting line from CommitGraph.svelte, leaving only commit dot circles. This is a teardown step to prepare for a lane rendering rewrite.

## Task Completion

| Task | Name | Commit | Files Modified |
|------|------|--------|----------------|
| 1 | Strip edge rendering from LaneSvg and WIP row | bd6dcea | LaneSvg.svelte, CommitGraph.svelte |

## Changes Made

### LaneSvg.svelte
- Removed the entire `{#each commit.edges as edge}` block containing Straight `<line>` elements and ForkLeft/ForkRight/MergeLeft/MergeRight `<path>` Bezier curves
- Removed the `maxCol` derived value (was computing max across commit column and all edge columns)
- Replaced `svgWidth` with simplified derivation: `(commit.column + 1) * laneWidth`
- Preserved the `<circle>` commit dot with all its styling (column position, merge vs normal radius, color, stroke)

### CommitGraph.svelte
- Removed the `<line>` element from the WIP row SVG that drew a vertical connecting line down to the first commit row
- Updated comment to reflect the line removal
- Preserved the hollow `<circle>` WIP dot unchanged

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

1. `svelte-check` passes with no new errors (1 pre-existing type error in SvelteVirtualList bind:this typing, unrelated)
2. `grep -c '<line\|<path' LaneSvg.svelte` = 0 (no edge elements)
3. `grep -c '<line' CommitGraph.svelte` = 0 (no line elements)
4. `grep -c '<circle' LaneSvg.svelte` = 1 (commit dot preserved)
5. `grep -c '<circle' CommitGraph.svelte` = 1 (WIP dot preserved)
6. Backend Rust code and TypeScript types remain unchanged

## Self-Check: PASSED

- FOUND: src/components/LaneSvg.svelte
- FOUND: src/components/CommitGraph.svelte
- FOUND: .planning/quick/2-remove-graph-lanes-keep-only-dots/2-SUMMARY.md
- FOUND: commit bd6dcea
