---
status: diagnosed
phase: 02-repository-open-commit-graph
source: [02-08-SUMMARY.md, previous UAT re-test]
started: 2026-03-09T00:00:00Z
updated: 2026-03-09T00:15:00Z
---

## Current Test

[testing complete]

## Tests

### 1. SVG lane lines connect commits
expected: The commit graph shows SVG lane lines connecting commits. Straight edges are vertical lines. Fork and merge points use curved (Bezier) connections. Merge commits show a larger dot with a ring. Regular commits show a smaller solid dot.
result: issue
reported: "branch lanes are still fucked up — all commits on a single vertical line, no forking to side columns for branches. Ref pills visible but lanes don't branch out."
severity: major

### 2. Branch fork topology
expected: Branch lanes fork from the parent commit row with curved connections. HEAD/main occupies column 0 (leftmost). Side branches (e.g. 'test', feature branches) appear in columns > 0, forking away from the main line — not as isolated vertical segments.
result: issue
reported: "still wrong — branches not forking to side columns, everything on a single vertical line"
severity: major

### 3. Lane color continuity across batch boundary
expected: Scroll past the ~200th commit (batch boundary). Lane lines remain visually continuous — no breaks, jumps, or misaligned lanes where one batch ends and the next begins. (Color may change when a lane column is reused by a different branch — this is expected.)
result: pass

## Summary

total: 3
passed: 1
issues: 2
pending: 0
skipped: 0

## Gaps

- truth: "The commit graph shows SVG lane lines with branches forking to side columns"
  status: failed
  reason: "User reported: branch lanes are still fucked up — all commits on a single vertical line, no forking to side columns for branches. Ref pills visible but lanes don't branch out."
  severity: major
  test: 1
  root_cause: "active_lanes[0] was initialized as None during head_chain pre-population (line 53 of graph.rs). Pass-through edge logic only emits Straight edges for columns where active_lanes[col].is_some(). Column 0 was None so no vertical line was drawn — fork curves connected to empty space."
  artifacts:
    - path: "src-tauri/src/git/graph.rs"
      issue: "active_lanes.push(None) at line 53 should be active_lanes.push(head_oid)"
  missing:
    - "Initialize active_lanes[0] with head_oid so pass-through Straight edges are emitted at column 0 on every row"
  debug_session: ".planning/debug/svg-lane-lines-broken.md"

- truth: "Branch lanes fork from the parent commit row with curved connections, HEAD on column 0, side branches on columns > 0"
  status: failed
  reason: "User reported: still wrong — branches not forking to side columns, everything on a single vertical line"
  severity: major
  test: 2
  root_cause: "Same root cause as test 1 — active_lanes[0] initialized as None meant no continuous main lane existed for fork edges to visually connect to"
  artifacts:
    - path: "src-tauri/src/git/graph.rs"
      issue: "active_lanes.push(None) at line 53 should be active_lanes.push(head_oid)"
  missing:
    - "Initialize active_lanes[0] with head_oid"
  debug_session: ".planning/debug/svg-lane-lines-broken.md"
