---
status: complete
phase: 11-stash-operations
source: [11-01-SUMMARY.md, 11-02-SUMMARY.md, 11-03-SUMMARY.md]
started: 2026-03-11T20:40:00Z
updated: 2026-03-11T20:55:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Stash Rows in Commit Graph
expected: When stashes exist, they appear as hollow square dots in the commit graph in a dedicated rightmost column, positioned near their parent commit.
result: issue
reported: "We ended up removing this completely because you just couldn't get it right."
severity: major

### 2. Stash Row Context Menu (Graph)
expected: Right-clicking a stash row in the commit graph shows a native context menu with Pop, Apply, and Drop actions.
result: skipped
reason: Stash rows were removed from the commit graph

### 3. Stash Drop Confirmation (Graph)
expected: Clicking Drop from the graph context menu shows a native OS confirmation dialog before executing. Cancelling does not drop the stash.
result: skipped
reason: Stash rows were removed from the commit graph

### 4. Stash Section Always Visible in Sidebar
expected: The Stash section is always visible in the sidebar, even when no stashes exist. It shows a '+' button in the header.
result: pass

### 5. Create Stash via Sidebar
expected: Clicking '+' in the stash section header shows an inline form with an optional name input and a Stash button. Submitting with dirty workdir creates a new stash. The stash list and graph update immediately.
result: issue
reported: "pass, but after creating the stash the UI did not update immediately."
severity: minor

### 6. Create Stash - Nothing to Stash
expected: Submitting the create stash form with a clean workdir shows a user-friendly inline error message (not a popup).
result: pass

### 7. Stash Entry Display in Sidebar
expected: Each stash entry in the sidebar list shows the short name (stash@{N}) and a truncated stash name/message.
result: pass

### 8. Stash Entry Context Menu (Sidebar)
expected: Right-clicking a stash entry in the sidebar shows a native context menu with Pop, Apply, and Drop actions.
result: pass

### 9. Stash Pop from Sidebar
expected: Clicking Pop from the sidebar context menu applies and removes the stash. The stash list and graph refresh immediately.
result: pass

### 10. Stash Apply from Sidebar
expected: Clicking Apply from the sidebar context menu applies the stash without removing it. The stash remains in the list.
result: pass

### 11. Stash Drop from Sidebar
expected: Clicking Drop from the sidebar context menu shows a native confirmation dialog. Confirming removes the stash. The list and graph update.
result: issue
reported: "did not work, and the stash stayed there"
severity: major

### 12. Stash Operation Error Display
expected: If a stash pop/apply fails (e.g., conflicts), an inline error message appears below the failing entry (not a modal/popup).
result: pass

## Summary

total: 12
passed: 6
issues: 5
pending: 0
skipped: 2

## Gaps

- truth: "Stash rows appear as hollow square dots in commit graph rightmost column"
  status: failed
  reason: "User reported: We ended up removing this completely because you just couldn't get it right."
  severity: major
  test: 1
  artifacts: []
  missing: []

- truth: "Hovering over stash entry in sidebar shows appropriate icon"
  status: failed
  reason: "User reported: When I hover over the stash it is showing a weird icon. Remove that."
  severity: cosmetic
  test: 4
  artifacts: []
  missing: []

- truth: "Clicking a stash in the sidebar shows the stash diff"
  status: failed
  reason: "User reported: Nothing happens when I click this stash on the sidebar. Which should show the stash diff when we click on the stash on the left sidebar."
  severity: major
  test: 4
  artifacts: []
  missing: []

- truth: "After creating a stash, the stash list and graph update immediately"
  status: failed
  reason: "User reported: after creating the stash the UI did not update immediately."
  severity: minor
  test: 5
  artifacts: []
  missing: []

- truth: "Stash Drop from sidebar removes the stash after confirmation"
  status: failed
  reason: "User reported: did not work, and the stash stayed there"
  severity: major
  test: 11
  artifacts: []
  missing: []
