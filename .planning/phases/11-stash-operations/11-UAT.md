---
status: diagnosed
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
  root_cause: "Feature was fully removed by user — stash graph rendering code no longer exists. No dead code remains."
  artifacts: []
  missing:
    - "Stash graph rendering was intentionally removed — no fix needed"
  debug_session: ""

- truth: "Hovering over stash entry in sidebar shows appropriate icon"
  status: failed
  reason: "User reported: When I hover over the stash it is showing a weird icon. Remove that."
  severity: cosmetic
  test: 4
  root_cause: "cursor: context-menu CSS on .stash-row (BranchSidebar.svelte line 411) renders macOS context-menu cursor icon on hover, inconsistent with other sidebar rows that use cursor: pointer or default"
  artifacts:
    - path: "src/components/BranchSidebar.svelte"
      issue: "cursor: context-menu on .stash-row"
  missing:
    - "Change cursor: context-menu to cursor: default on .stash-row"
  debug_session: ""

- truth: "Clicking a stash in the sidebar shows the stash diff"
  status: failed
  reason: "User reported: Nothing happens when I click this stash on the sidebar. Which should show the stash diff when we click on the stash on the left sidebar."
  severity: major
  test: 4
  root_cause: "Feature never implemented — no onclick handler on stash rows, no stash OID in StashEntry type (discarded during listing), no diff_stash command (though existing diff_commit can be reused since stashes are commits)"
  artifacts:
    - path: "src/components/BranchSidebar.svelte"
      issue: "No onclick handler on stash rows (only oncontextmenu)"
    - path: "src-tauri/src/commands/stash.rs"
      issue: "list_stashes_inner discards stash OID at line 26"
    - path: "src-tauri/src/git/types.rs"
      issue: "StashEntry struct missing stash commit OID field"
    - path: "src/lib/types.ts"
      issue: "StashEntry interface missing stash commit OID field"
  missing:
    - "Add stash OID field to StashEntry (Rust struct and TS interface)"
    - "Preserve stash OID in list_stashes_inner instead of discarding"
    - "Add onclick handler on stash rows that calls handleCommitSelect with stash OID"
  debug_session: ""

- truth: "After creating a stash, the stash list and graph update immediately"
  status: failed
  reason: "User reported: after creating the stash the UI did not update immediately."
  severity: minor
  test: 5
  root_cause: "All 4 stash handlers (save/pop/apply/drop) are missing onrefreshed?.() call after loadRefs — other handlers like handleCheckout and handleCreateBranch call it. Without it, graph refresh relies on repo-changed event with 200ms debounce."
  artifacts:
    - path: "src/components/BranchSidebar.svelte"
      issue: "handleStashSave (line 148), handleStashPop (line 178), handleStashApply (line 189), handleStashDrop (line 206) all missing onrefreshed?.() after loadRefs"
  missing:
    - "Add onrefreshed?.() after await loadRefs(repoPath) in all 4 stash handlers"
  debug_session: ""

- truth: "Stash Drop from sidebar removes the stash after confirmation"
  status: failed
  reason: "User reported: did not work, and the stash stayed there"
  severity: major
  test: 11
  root_cause: "Missing Tauri permission for ask() dialog — capabilities/default.json only grants dialog:allow-open, not dialog:allow-ask. The ask() call is denied silently (unhandled rejection in menu callback)."
  artifacts:
    - path: "src-tauri/capabilities/default.json"
      issue: "Only dialog:allow-open granted, missing dialog:allow-ask"
    - path: "src/components/BranchSidebar.svelte"
      issue: "Menu callback doesn't await/catch handleStashDrop, silently swallows permission error"
  missing:
    - "Add dialog:allow-ask to capabilities/default.json (or use dialog:default for all dialog permissions)"
    - "Handle promise rejections in menu action callbacks"
  debug_session: ""
