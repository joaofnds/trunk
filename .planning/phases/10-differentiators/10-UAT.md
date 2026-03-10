---
status: complete
phase: 10-differentiators
source: [10-01-SUMMARY.md, 10-02-SUMMARY.md]
started: 2026-03-09T23:00:00Z
updated: 2026-03-09T23:15:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Lane-Colored Ref Pills
expected: Branch and tag pills next to commits use the lane color of their commit (not static green/accent). Each pill background matches the colored lane the commit sits in, with white text.
result: pass

### 2. Remote-Only Ref Dimming
expected: Remote branches that have no corresponding local branch appear dimmed at 50% opacity compared to local branches or tags.
result: pass

### 3. Connector Line from Pills to Commit Dot
expected: Commits that have ref pills show a horizontal line connecting from the pill area to the commit dot in the graph column. Commits in column 0 and WIP rows should not have this line.
result: issue
reported: "this is currently not working, and furthermore, I just noticed that the WIP dotted line is not connecting to the HEAD commit anymore"
severity: major

### 4. Six-Column Commit Row Layout
expected: Each commit row displays 6 columns: branch/tag refs, graph (SVG lanes), commit message, author name, date (relative like "2d", "3mo"), and short SHA.
result: pass

### 5. Fixed Header Row
expected: A fixed header row with column labels (Branch/Tag, Graph, Message, Author, Date, SHA) appears above the scrollable commit list and stays visible while scrolling.
result: pass

### 6. Drag-to-Resize Columns
expected: Hovering between column headers shows a resize cursor. Dragging resizes the columns. The message column flexes to fill remaining space. Graph column has a minimum width that prevents lane clipping.
result: issue
reported: "it does work when hovering, but we should have a visible divider even without hovering, so we know where the divider is, and don't have to hunt it"
severity: minor

### 7. Column Width Persistence
expected: After resizing columns, close and reopen the app. The column widths are restored to the sizes you set, not the defaults.
result: pass

## Summary

total: 7
passed: 5
issues: 2
pending: 0
skipped: 0

## Gaps

- truth: "Commits with ref pills show a horizontal connector line to the commit dot; WIP dotted line connects to HEAD commit"
  status: failed
  reason: "User reported: this is currently not working, and furthermore, I just noticed that the WIP dotted line is not connecting to the HEAD commit anymore"
  severity: major
  test: 3
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "Column dividers are visible without hovering so users can locate resize handles"
  status: failed
  reason: "User reported: it does work when hovering, but we should have a visible divider even without hovering, so we know where the divider is, and don't have to hunt it"
  severity: minor
  test: 6
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
