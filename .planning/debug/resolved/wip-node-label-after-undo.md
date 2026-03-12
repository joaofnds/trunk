---
status: resolved
trigger: "WIP commit node in commit graph doesn't update label after undo operation"
created: 2026-03-12T00:00:00Z
updated: 2026-03-12T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - CommitForm clears subject programmatically after commit but never calls onsubjectchange, so wipSubject in App.svelte stays stale
test: Traced full data flow from CommitForm -> App.svelte -> CommitGraph
expecting: Found the exact disconnect
next_action: Report root cause

## Symptoms

expected: After undo, WIP node in commit graph should show "WIP"
actual: WIP node retains old commit message text after undo
errors: none
reproduction: Type message in commit form, commit, click Undo, observe graph WIP node still shows old message
started: Since undo/redo feature was added

## Eliminated

## Evidence

- timestamp: 2026-03-12
  checked: CommitForm.svelte oninput handler (line 96)
  found: onsubjectchange is ONLY called from the DOM oninput event handler, not from programmatic subject changes
  implication: When subject is set to '' after commit (line 73), onsubjectchange is never called

- timestamp: 2026-03-12
  checked: App.svelte wipSubject flow (lines 31, 345, 360)
  found: wipSubject is set via onsubjectchange callback from StagingPanel/CommitForm, and passed as wipMessage to CommitGraph
  implication: wipSubject is the single source of truth for the WIP node label

- timestamp: 2026-03-12
  checked: CommitGraph.svelte makeWipItem and displayItems (lines 229-253)
  found: WIP node summary comes from wipMessage prop, which comes from wipSubject.trim() || 'WIP'
  implication: If wipSubject is stale, the WIP node label is stale

- timestamp: 2026-03-12
  checked: Toolbar.svelte handleUndo (lines 53-63)
  found: Undo calls undo_commit backend command but does nothing to clear wipSubject or notify CommitForm
  implication: Undo path has no mechanism to reset the WIP label

## Resolution

root_cause: CommitForm.svelte clears its local `subject` state (line 73) after a successful commit, but this is a programmatic assignment that does NOT trigger the `oninput` DOM event. Therefore `onsubjectchange?.('')` is never called, and `wipSubject` in App.svelte retains the old commit message. When undo restores uncommitted changes (wipCount > 0), the WIP node reappears with the stale wipSubject value.
fix: Call onsubjectchange?.('') in CommitForm.svelte after clearing subject on line 73
verification:
files_changed: []
