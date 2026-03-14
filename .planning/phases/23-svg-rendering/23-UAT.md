---
status: diagnosed
phase: 23-svg-rendering
source: 23-01-SUMMARY.md, 23-02-SUMMARY.md
started: 2026-03-14T04:50:00Z
updated: 2026-03-14T05:10:00Z
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
  root_cause: "SVG uses class='absolute top-0 left-0' but the Graph column starts after the Ref column (~120px). The SVG left edge must be offset by columnWidths.ref to align with the graph column."
  artifacts:
    - path: "src/components/CommitGraph.svelte"
      issue: "line 432: class='absolute top-0 left-0' — left-0 anchors SVG at x=0, but graph content is at x=columnWidths.ref (~120px)"
  missing:
    - "Set SVG left style to columnWidths.ref (or 0 when ref column hidden) instead of hardcoded left-0"
  debug_session: ".planning/debug/overlay-positioned-to-side.md"

- truth: "Commit dots and branch lines remain visible while scrolling through the graph"
  status: failed
  reason: "User reported: for some reason commit dots are disappearing when I scroll (branch lines as well)"
  severity: major
  test: 6
  root_cause: "OVERLAY_ROW_HEIGHT=36 in graph-constants.ts does not match actual rendered ROW_HEIGHT=26. Dot Y coordinates (row × 36) exceed the SVG height (numItems × 26), causing browser clipping. Bottom 28% of commits have invisible overlay elements."
  artifacts:
    - path: "src/lib/graph-constants.ts"
      issue: "OVERLAY_ROW_HEIGHT=36 should equal ROW_HEIGHT=26 — two constants for the same conceptual row height"
    - path: "src/lib/overlay-paths.ts"
      issue: "Uses OVERLAY_ROW_HEIGHT for all Y coordinate computation — auto-corrects if constant is fixed"
    - path: "src/components/CommitGraph.svelte"
      issue: "overlayCy/overlayCx helpers use OVERLAY_ROW_HEIGHT — auto-corrects if constant is fixed"
  missing:
    - "Change OVERLAY_ROW_HEIGHT from 36 to 26 in graph-constants.ts so overlay Y coordinates match SVG height"
  debug_session: ".planning/debug/overlay-elements-disappear-on-scroll.md"
