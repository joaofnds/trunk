---
status: complete
phase: 25-interaction-preservation
source: [25-01-SUMMARY.md]
started: 2026-03-14T13:00:00Z
updated: 2026-03-14T13:05:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Selected Commit Row Highlight
expected: Click on a commit row in the graph. The row displays a persistent subtle blue-tinted background (10% opacity accent). While selected, the hover highlight is suppressed on that row.
result: pass

### 2. Stash Context Menu
expected: Right-click on a stash row in the commit graph. A context menu appears with Pop, Apply, and Drop options (not the full commit context menu).
result: pass

### 3. Drop Stash Confirmation Dialog
expected: Right-click a stash row, select Drop. A confirmation dialog appears before the stash is actually dropped.
result: pass

### 4. WIP Row Exclusion
expected: The WIP (work-in-progress) row does not show a selection highlight when clicked, and does not show a context menu when right-clicked.
result: pass

## Summary

total: 4
passed: 4
issues: 0
pending: 0
skipped: 0

## Gaps

[none yet]
