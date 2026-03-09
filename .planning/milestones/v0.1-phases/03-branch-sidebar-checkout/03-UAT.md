---
status: diagnosed
phase: 03-branch-sidebar-checkout
source: [03-01-SUMMARY.md, 03-02-SUMMARY.md, 03-03-SUMMARY.md]
started: 2026-03-04T14:10:00Z
updated: 2026-03-04T14:11:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Sidebar visible
expected: Open a Git repository in the app. The branch sidebar (dark background, ~220px wide) appears to the left of the commit graph. Both panels fill the full viewport height. The commit graph occupies all remaining horizontal space to the right.
result: pass

### 2. Local branches listed with HEAD highlighted
expected: The Local section is expanded by default. All local branches are listed. The currently checked-out branch (HEAD) is styled with accent color (blue) and bold text. Other branches are in normal text.
result: pass

### 3. Collapsible sections
expected: Click the Local section header — it collapses and hides the branch list. Click again — it expands. The chevron (▶/▼) toggles accordingly.
result: issue
reported: "it is not working all the time. Some times it doesn't work, then I restart the app and it works. (same repo)"
severity: major

### 4. Section counts
expected: Each section header shows a count in parentheses, e.g. "Local (3)", "Remote (12)". The count matches the actual number of branches/tags/stashes in that section.
result: pass

### 5. Empty sections hidden
expected: If the open repository has no tags, the Tags section is not visible at all. If it has no stashes, the Stashes section is not visible. Only sections with at least one item are shown.
result: pass

### 6. Remote branches grouped by remote name
expected: Expand the Remote section. Branches are grouped under sub-headers showing the remote name in uppercase (e.g. "ORIGIN"). There is no "HEAD" entry in the remote list (origin/HEAD is filtered out). Each remote group shows its branches indented below the sub-header.
result: issue
reported: "remote section is looking super ugly. The text is wrapping over itself"
severity: major

### 7. Search filter — frontend only, no backend round-trip
expected: Type a partial branch name into the search box. The branch list in all sections filters immediately to matching names. Clearing the search box restores all branches. The filter works without any loading delay (it's computed locally — no spinner, no network call).
result: pass

### 8. Checkout — clean working tree
expected: With a clean working tree (no uncommitted changes), click a local branch that is not HEAD. The sidebar highlight moves to the clicked branch (accent color + bold). The commit graph remounts and the HEAD marker moves to the correct commit. No error appears.
result: issue
reported: "pass, but if the branch is further down, the graph doesn't scroll to it"
severity: minor

### 9. Checkout — dirty working tree blocked
expected: Make an edit to a tracked file without staging or committing it. Click a different local branch. An inline red error banner appears directly below the clicked branch row with text about uncommitted changes. The sidebar highlight does NOT move — the original HEAD branch remains highlighted. The working tree is unchanged.
result: pass

### 10. Error banner dismisses on search
expected: With the dirty-workdir error banner visible below a branch row, type any character in the search box. The error banner disappears immediately.
result: pass

### 11. Create branch — inline input
expected: Click the "+" button in the Local section header. An inline text input appears. Type a new branch name and press Enter — the new branch is created, auto-checked-out (appears as HEAD with accent highlight), and the commit graph remounts. Pressing Escape instead cancels without creating a branch.
result: pass

## Summary

total: 11
passed: 8
issues: 3
pending: 0
skipped: 0

## Gaps

- truth: "Clicking the section header collapses/expands the branch list reliably on every click"
  status: failed
  reason: "User reported: it is not working all the time. Some times it doesn't work, then I restart the app and it works. (same repo)"
  severity: major
  test: 3
  root_cause: "BranchSidebar.svelte sets refs = null synchronously in the $effect before loadRefs resolves, causing Remote/Tags/Stashes BranchSection components to be destroyed and recreated. Clicks during the destroy/recreate window find no live handler. Secondary: loadRefs has no cancellation guard so concurrent calls (from checkout + create) can race and re-trigger the same cycle."
  artifacts:
    - path: "src/components/BranchSidebar.svelte"
      issue: "refs = null in $effect (line ~64) destroys BranchSection components on every refresh; no sequence counter on loadRefs prevents stale call from overwriting fresh data"
  missing:
    - "Replace refs = null with a separate loading boolean; never null out refs during refresh"
    - "Add sequence counter to loadRefs to discard stale responses"
  debug_session: ".planning/debug/branch-sidebar-click-freeze.md"

- truth: "Branch names in the remote section display on a single line, truncated with ellipsis if too long"
  status: failed
  reason: "User reported: remote section is looking super ugly. The text is wrapping over itself"
  severity: major
  test: 6
  root_cause: "BranchRow.svelte inner flex container and text node are missing overflow:hidden + whitespace:nowrap + text-ellipsis + min-width:0. Flex children default to min-width:auto so they expand past the 220px sidebar boundary instead of clipping."
  artifacts:
    - path: "src/components/BranchRow.svelte"
      issue: "Text node on line ~43 has no wrapping span with truncate classes; flex container missing overflow:hidden"
    - path: "src/components/RemoteGroup.svelte"
      issue: "Indent wrapper div missing overflow:hidden defensive guard"
  missing:
    - "Wrap text node in <span class='truncate min-w-0 flex-1'> in BranchRow.svelte"
    - "Add overflow-hidden to BranchRow inner flex container"
  debug_session: ".planning/debug/branch-name-truncation.md"

- truth: "After checkout, the commit graph scrolls to show the new HEAD commit"
  status: failed
  reason: "User reported: pass, but if the branch is further down, the graph doesn't scroll to it"
  severity: minor
  test: 8
  root_cause: "CommitGraph.svelte has no scroll-to-HEAD logic. SvelteVirtualList always initialises at offset 0. GraphCommit.is_head is already present in the data but never used to drive a scroll call. SvelteVirtualList exposes a scroll({index}) method via bind:this that is never called."
  artifacts:
    - path: "src/components/CommitGraph.svelte"
      issue: "No bind:this on SvelteVirtualList, no $effect to call listRef.scroll({index: headIdx}) after initial load"
  missing:
    - "Add bind:this={listRef} on SvelteVirtualList"
    - "After first batch loads, find headIdx = commits.findIndex(c => c.is_head) and call listRef.scroll({index: headIdx, smoothScroll: false, align: 'top'}) once"
  debug_session: ".planning/debug/commit-graph-no-scroll-to-head.md"
