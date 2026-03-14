---
status: complete
phase: 23-svg-rendering
source: 23-01-SUMMARY.md, 23-02-SUMMARY.md
started: 2026-03-14T04:50:00Z
updated: 2026-03-14T05:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. SVG Overlay Renders
expected: Open the app and navigate to a repository with commits. The commit graph should show an SVG overlay on top of the existing rendering — you should see colored lane rails (vertical lines), bezier curve connections between branches, and commit dots.
result: issue
reported: "it's to the side, not on top"
severity: major

### 2. Normal Commit Dots
expected: Regular (non-merge, non-WIP, non-stash) commits appear as filled colored circles in the SVG overlay. Each dot is solid/filled with the lane color.
result: pass

### 3. Merge Commit Dots
expected: Merge commits (commits with two parents) appear as hollow circles — the center is transparent (showing the background), with only a colored ring/stroke visible. They should look visually distinct from normal filled dots.
result: pass

### 4. WIP Commit Dot
expected: If you have uncommitted changes, the WIP entry at the top of the graph appears as a hollow dashed circle — the stroke is drawn with a dash pattern (gaps in the ring), making it look distinct from merge commits.
result: pass

### 5. Stash Commit Dots
expected: Stash entries appear as filled colored squares (rectangles) rather than circles, making them visually distinguishable from all commit types.
result: pass

### 6. Viewport Virtualization
expected: Scroll through a repository with many commits (100+). The SVG overlay should only render elements visible in the current viewport — the DOM node count should stay bounded regardless of total commit count (no performance degradation on scroll).
result: issue
reported: "for some reason commit dots are disappearing when I scroll (branch lines as well)"
severity: major

## Summary

total: 6
passed: 4
issues: 2
pending: 0
skipped: 0

## Gaps

- truth: "SVG overlay renders on top of the existing commit graph rendering"
  status: failed
  reason: "User reported: it's to the side, not on top"
  severity: major
  test: 1
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "Commit dots and branch lines remain visible while scrolling through the graph"
  status: failed
  reason: "User reported: for some reason commit dots are disappearing when I scroll (branch lines as well)"
  severity: major
  test: 6
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
