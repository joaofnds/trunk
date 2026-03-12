---
status: diagnosed
phase: 11-stash-operations
source: [11-01-SUMMARY.md, 11-02-SUMMARY.md, 11-03-SUMMARY.md, 11-04-SUMMARY.md]
started: 2026-03-11T21:00:00Z
updated: 2026-03-11T21:15:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Stash Section Always Visible
expected: The Stash section is always visible in the sidebar, even when no stashes exist. It shows a '+' button in the header.
result: pass

### 2. Create Stash via Sidebar
expected: Clicking '+' in the stash section header shows an inline form with an optional name input and a Stash button. Submitting with dirty workdir creates a new stash.
result: pass

### 3. UI Refresh After Create Stash
expected: After creating a stash, the stash list updates immediately without needing to manually refresh.
result: issue
reported: "pass, but the whole UI does a hard refresh and I see the screen flashing white."
severity: minor

### 4. Create Stash - Nothing to Stash
expected: Submitting the create stash form with a clean workdir shows a user-friendly inline error message (not a popup).
result: issue
reported: "pass, but if this stash list on the left sidebar is closed, clicking the plus button doesn't expand it. It should expand it."
severity: minor

### 5. Stash Entry Display
expected: Each stash entry in the sidebar list shows the short name (stash@{N}) and a truncated stash name/message.
result: pass

### 6. Stash Entry Hover Cursor
expected: Hovering over a stash entry in the sidebar shows a normal/default cursor (not a context-menu icon).
result: pass

### 7. Click Stash Shows Diff
expected: Clicking a stash entry in the sidebar loads its diff in the right pane (same as clicking a commit).
result: pass

### 8. Stash Entry Context Menu
expected: Right-clicking a stash entry in the sidebar shows a native context menu with Pop, Apply, and Drop actions.
result: pass

### 9. Stash Pop
expected: Clicking Pop from the context menu applies and removes the stash. The stash list refreshes immediately.
result: pass

### 10. Stash Apply
expected: Clicking Apply from the context menu applies the stash without removing it. The stash remains in the list.
result: pass

### 11. Stash Drop with Confirmation
expected: Clicking Drop from the context menu shows a native OS confirmation dialog. Confirming removes the stash. Cancelling keeps it.
result: pass

### 12. Stash Operation Error Display
expected: If a stash pop/apply fails (e.g., conflicts), an inline error message appears below the failing entry (not a modal/popup).
result: pass

## Summary

total: 12
passed: 10
issues: 2
pending: 0
skipped: 0

## Gaps

- truth: "After creating a stash, the stash list updates smoothly without full UI flash"
  status: failed
  reason: "User reported: pass, but the whole UI does a hard refresh and I see the screen flashing white."
  severity: minor
  test: 3
  root_cause: "Double refresh trigger: handleStashSave calls onrefreshed?.() immediately AND the backend emits repo-changed event, causing two near-simultaneous refresh cycles. The combination of refs state update, refreshSignal increment, dirty counts reload, and file diff refetch happening in rapid succession causes multiple repaints that appear as a white flash."
  artifacts:
    - path: "src/components/BranchSidebar.svelte"
      issue: "handleStashSave calls onrefreshed?.() triggering immediate refresh"
    - path: "src-tauri/src/commands/stash.rs"
      issue: "stash_save emits repo-changed event triggering second refresh"
    - path: "src/App.svelte"
      issue: "repo-changed listener fires handleRefresh() redundantly after onrefreshed already triggered it"
  missing:
    - "Remove onrefreshed?.() from stash handlers and rely solely on repo-changed event with debounce, OR prevent redundant handleRefresh() calls within a short window"
  debug_session: ""

- truth: "Clicking '+' on a collapsed stash section expands it and shows the create form"
  status: failed
  reason: "User reported: pass, but if this stash list on the left sidebar is closed, clicking the plus button doesn't expand it. It should expand it."
  severity: minor
  test: 4
  root_cause: "The oncreate handler on the stash section only toggles showStashForm without expanding the section. BranchSection renders children only when expanded is true ({#if expanded}), so the form is invisible when the section is collapsed."
  artifacts:
    - path: "src/components/BranchSidebar.svelte"
      issue: "oncreate handler (line 343) toggles showStashForm but does not set stashesExpanded = true"
    - path: "src/components/BranchSection.svelte"
      issue: "Children only render when expanded is true (line 61)"
  missing:
    - "Add stashesExpanded = true to the oncreate handler so clicking '+' expands the section"
  debug_session: ""
