---
status: diagnosed
phase: 02-repository-open-commit-graph
source: [02-04-SUMMARY.md, 02-05-SUMMARY.md, 02-06-SUMMARY.md, 02-07-SUMMARY.md]
started: 2026-03-08T00:00:00Z
updated: 2026-03-08T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Welcome screen on launch
expected: Launch the app with no repository open. A welcome screen appears with an "Open Repository" button centered in the view.
result: pass

### 2. Open repository via folder picker
expected: Click "Open Repository". A native OS folder picker dialog opens. Select a Git repository folder — the app transitions from the welcome screen to the commit graph view.
result: pass

### 3. Tab bar shows repo name
expected: After opening a repo, a tab bar appears at the top showing the repository name. An X close button is visible on the tab.
result: pass

### 4. Commit graph displays commits
expected: The commit graph shows a scrollable list of commits. Each row displays: a short OID (hash) and the commit summary message.
result: pass

### 5. Ref pills on commits
expected: Commits that are branch tips or tagged show colored pill badges. HEAD is blue, local branches are green, remote branches are gray-blue. If a commit has many refs, overflow is handled with a +N indicator.
result: pass

### 6. SVG lane lines
expected: The commit graph shows SVG lane lines connecting commits. Straight edges are vertical lines. Fork and merge points use curved (Bezier) connections. Merge commits show a larger dot with a ring. Regular commits show a smaller solid dot.
result: issue
reported: "now they do have a line, but the branch lane line is completely off. The branch line should fork from the parent commit row. Branch lanes like 'test' and 'vk/76cb-review-c' show as isolated vertical segments instead of forking from the parent commit with a curved connection."
severity: major

### 7. Infinite scroll pagination
expected: Scroll down through the commit list. When nearing the bottom, the next batch of commits loads automatically (no manual "load more" button needed). A skeleton loading animation appears briefly while loading.
result: pass

### 8. Lane continuity across batch boundary
expected: Scroll past the ~200th commit (batch boundary). Lane lines remain visually continuous — no breaks, jumps, or misaligned lanes where one batch ends and the next begins.
result: issue
reported: "yes but in some repos it switches colors, something is odd there."
severity: minor

### 9. Close repo returns to welcome
expected: Click the X button on the tab bar. The commit graph disappears and the welcome screen reappears with the "Open Repository" button.
result: pass

### 10. Recent repos list
expected: After closing and reopening the app (or closing a repo), the welcome screen shows a list of recently opened repositories. Clicking a recent repo entry opens it directly without showing the folder picker.
result: pass

### 11. Recent repos persist across restart
expected: Open a repository, then quit the app entirely. Relaunch the app — the welcome screen still shows the previously opened repo in the recent repos list.
result: pass

### 12. Remove recent repo entry
expected: On the welcome screen, each recent repo entry has a remove/X button. Clicking it removes that entry from the list without opening the repo.
result: pass

## Summary

total: 12
passed: 10
issues: 2
pending: 0
skipped: 0

## Gaps

- truth: "The commit graph shows SVG lane lines connecting commits with straight edges, curved fork/merge connections, merge dot with ring, and regular solid dots"
  status: resolved
  reason: "User reported: lanes are broken. Commits show dots but there are no lane lines connecting them at all. No vertical lines, no curves, no fork/merge connections. Just isolated dots in a single column."
  severity: major
  test: 6
  root_cause: "walk_commits() in graph.rs never emits a Straight edge for a commit's first-parent lane continuation. The first-parent handling block (lines 74-83) assigns the parent to the current column but never pushes a GraphEdge. Only pass-through edges for other active lanes are emitted."
  artifacts:
    - path: "src-tauri/src/git/graph.rs"
      issue: "First-parent handling block (lines 74-83) does lane bookkeeping but never emits a GraphEdge for the straight vertical connection"
  missing:
    - "After first-parent lane assignment, push GraphEdge { from_column: col, to_column: col, edge_type: EdgeType::Straight, color_index: col }"
    - "Add test assertion that non-root linear commits have at least one Straight edge"
  debug_session: ".planning/debug/svg-lane-lines-broken.md"

- truth: "Fork and merge points use curved (Bezier) connections — branch lanes fork from the parent commit row"
  status: failed
  reason: "User reported: now they do have a line, but the branch lane line is completely off. The branch line should fork from the parent commit row. Branch lanes like 'test' and 'vk/76cb-review-c' show as isolated vertical segments instead of forking from the parent commit with a curved connection."
  severity: major
  test: 6
  root_cause: "Two interrelated bugs in walk_commits(): (1) No branch-priority heuristic for column assignment — revwalk visits branch tips before shared ancestors, so side branches claim column 0 before main, inverting the visual hierarchy. (2) No fork edges emitted at divergence points — the algorithm only emits edges going downward from a commit to its parents and has no child-tracking mechanism to know when multiple children diverge from a shared ancestor."
  artifacts:
    - path: "src-tauri/src/git/graph.rs"
      issue: "Lines 39-50: column assignment has no priority heuristic for HEAD/first-parent chain"
    - path: "src-tauri/src/git/graph.rs"
      issue: "Lines 72-148: parent handling emits no fork edges at divergence points, no child-tracking mechanism"
  missing:
    - "Priority heuristic to ensure HEAD/first-parent chain claims column 0 before branch tips"
    - "Mechanism to emit fork edges at divergence points — either child tracking during walk or second pass inserting fork edges on ancestor rows"
  debug_session: ".planning/debug/branch-fork-edges-missing.md"

- truth: "Lane lines remain visually continuous across batch boundaries — no color switches"
  status: not_a_bug
  reason: "User reported: yes but in some repos it switches colors, something is odd there."
  severity: minor
  test: 8
  root_cause: "Not a bug. The full graph is computed once at repo open and cached. Pagination slices the cached array — no recomputation. What the user likely observes is lane column reuse: when a branch terminates near a batch boundary, its column is freed and reused by a new branch. Same column = same color but different branch identity. This is correct behavior."
  debug_session: ".planning/debug/lane-color-switching-at-batch-boundary.md"
