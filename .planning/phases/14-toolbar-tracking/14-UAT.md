---
status: complete
phase: 14-toolbar-tracking
source: 14-01-SUMMARY.md, 14-02-SUMMARY.md, 14-03-SUMMARY.md
started: 2026-03-12T18:00:00Z
updated: 2026-03-12T18:10:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Ahead/Behind Badges on Branch Row
expected: In the branch sidebar, local branches that track a remote show compact arrow badges (e.g., ↓2 ↑1) right-aligned in the row. Branches without a remote show no badges.
result: pass

### 2. Ahead/Behind Updates After Remote Operations
expected: After performing a fetch, pull, or push, the ahead/behind badges update to reflect the new state (e.g., pushing clears the ↑ count).
result: pass

### 3. Undo Button Reverts Last Commit
expected: After making a commit, clicking the Undo button soft-resets it — the commit disappears from the log, changes return to the working tree, and the commit message is preserved for redo.
result: pass

### 4. WIP Node Label Updates After Undo
expected: After undoing a commit, the WIP commit node in the graph immediately shows "WIP" (not the old commit message). The commit form on the right sidebar should be empty.
result: pass

### 5. Redo Button Re-commits After Undo
expected: After undoing a commit, clicking the Redo button re-commits with the original message. The commit reappears in the log. Redo button becomes active immediately after undo.
result: pass

### 6. Undo Disabled on Initial/Merge Commits
expected: The Undo button is disabled (greyed out) when HEAD is the initial commit or a merge commit.
result: pass

### 7. Redo Disabled When Stack Empty
expected: The Redo button is disabled when no undo has been performed. After undoing and then making a new manual commit, the redo stack clears and Redo becomes disabled again.
result: pass

### 8. Toolbar Button Order
expected: Toolbar buttons appear in this order: [Undo] [Redo] | [Pull] [Push] | [Branch] [Stash] [Pop]
result: pass

## Summary

total: 8
passed: 8
issues: 0
pending: 0
skipped: 0

## Gaps

[none]
