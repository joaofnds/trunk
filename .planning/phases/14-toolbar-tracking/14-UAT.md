---
status: diagnosed
phase: 14-toolbar-tracking
source: 14-01-SUMMARY.md, 14-02-SUMMARY.md
started: 2026-03-12T16:00:00Z
updated: 2026-03-12T16:10:00Z
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
expected: After making a commit, clicking the Undo button in the toolbar soft-resets it — the commit disappears from the log, but changes return to the working tree. The commit message is preserved for redo.
result: issue
reported: "pass, but in the graph the WIP commit stayed with the commit message while the right sidebar commit form was empty. I had to write something to the right sidebar commit form box and then delete clear it for the WIP commit on the commit graph to go back to WIP (Which is shown when the commit box is empty)"
severity: minor

### 4. Redo Button Re-commits After Undo
expected: After undoing a commit, clicking the Redo button re-commits with the original message. The commit reappears in the log.
result: issue
reported: "The redo button staying inactive."
severity: major

### 5. Undo Disabled on Initial/Merge Commits
expected: The Undo button is disabled (greyed out) when HEAD is the initial commit or a merge commit.
result: pass

### 6. Redo Disabled When Stack Empty
expected: The Redo button is disabled when no undo has been performed (empty redo stack). After undoing and then making a new commit, the redo stack clears and Redo becomes disabled again.
result: issue
reported: "Like I said in the previous one, redo is not working."
severity: major

### 7. Toolbar Button Order
expected: Toolbar buttons appear in this order: [Undo] [Redo] | [Pull] [Push] | [Branch] [Stash] [Pop]
result: pass

## Summary

total: 7
passed: 4
issues: 3
pending: 0
skipped: 0

## Gaps

- truth: "WIP commit node in graph updates its label after undo resets the commit"
  status: failed
  reason: "User reported: pass, but in the graph the WIP commit stayed with the commit message while the right sidebar commit form was empty. I had to write something to the right sidebar commit form box and then delete clear it for the WIP commit on the commit graph to go back to WIP (Which is shown when the commit box is empty)"
  severity: minor
  test: 3
  root_cause: "CommitForm.svelte clears subject programmatically (line 73) after commit but never calls onsubjectchange?.(''), so wipSubject in App.svelte stays stale. When WIP node reappears after undo, it uses the stale wipSubject instead of falling back to 'WIP'."
  artifacts:
    - path: "src/components/CommitForm.svelte"
      issue: "Line 73 clears subject without notifying parent via onsubjectchange"
    - path: "src/App.svelte"
      issue: "Line 31/345: wipSubject stays stale, passed as wipMessage to CommitGraph"
  missing:
    - "Add onsubjectchange?.('') after subject = '' in CommitForm.handleSubmit()"
  debug_session: ".planning/debug/wip-node-label-after-undo.md"

- truth: "Redo button becomes active after undoing a commit and re-commits with original message"
  status: failed
  reason: "User reported: The redo button staying inactive."
  severity: major
  test: 4
  root_cause: "Race condition: isUndoing flag is reset to false in finally block before async repo-changed events arrive. When repo-changed fires, isUndoing is already false so the guard passes and clearRedoStack() wipes the stack. A second repo-changed from the filesystem watcher (~300ms debounce) clears it again."
  artifacts:
    - path: "src/components/Toolbar.svelte"
      issue: "Lines 42-44: guard checks isUndoing but it's already false when events arrive"
    - path: "src/components/Toolbar.svelte"
      issue: "Lines 53-62: handleUndo resets isUndoing in finally before events process"
    - path: "src-tauri/src/commands/commit_actions.rs"
      issue: "Line 380: backend emits repo-changed before returning IPC result"
    - path: "src-tauri/src/watcher.rs"
      issue: "Line 24: filesystem watcher emits second repo-changed ~300ms later"
  missing:
    - "Stop clearing redo stack in repo-changed handler; instead clear explicitly at start of user-initiated operations (commit, cherry-pick, revert)"
  debug_session: ".planning/debug/redo-button-stays-disabled.md"

- truth: "Redo button disabled state correctly reflects redo stack state"
  status: failed
  reason: "User reported: Like I said in the previous one, redo is not working."
  severity: major
  test: 6
  root_cause: "Same root cause as test 4 — redo stack is cleared by repo-changed event race condition, so canRedo never becomes true."
  artifacts:
    - path: "src/components/Toolbar.svelte"
      issue: "Same race condition as test 4"
  missing:
    - "Same fix as test 4"
  debug_session: ".planning/debug/redo-button-stays-disabled.md"
