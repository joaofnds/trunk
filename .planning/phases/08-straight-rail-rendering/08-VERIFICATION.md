---
phase: 08-straight-rail-rendering
verified: 2026-03-09T21:30:00Z
status: human_needed
score: 4/4 must-haves verified
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  note: "Re-verification after fork-edge rendering fixes (commit 5e2e239). Previous verification was stale -- backend algorithm changed significantly (fork edges emitted on parent row, is_branch_tip field, branch lanes stay active between child and parent). All automated checks pass again on the updated code."
human_verification:
  - test: "Verify continuous vertical rails with no gaps at all zoom levels"
    expected: "Each branch shows a continuous vertical colored line from tip to base with no visible hairline gaps between rows. Branch tip rails start at the dot (not above it)."
    why_human: "Sub-pixel rendering gaps depend on browser/webview rendering engine and zoom level"
  - test: "Verify fork edges render upward from parent commit to row top"
    expected: "When a branch forks from a parent commit, the fork edge starts at the parent dot, goes horizontal toward the branch column, arcs upward, and extends to the row top. The branch rail then continues as a straight pass-through in the rows above until reaching the branch tip."
    why_human: "SVG path rendering direction changed from child-emitted to parent-emitted in commit 5e2e239 -- visual correctness of the new upward routing must be confirmed"
  - test: "Verify all 8 lane colors are vivid and high-contrast"
    expected: "All lane colors are clearly visible and distinguishable against the #0d1117 dark background"
    why_human: "Color contrast and visibility is a visual perception judgment"
  - test: "Verify commit dots render on top of rails and edge paths"
    expected: "Commit dots are fully visible on top of rail lines and connection paths, not clipped or hidden"
    why_human: "Z-ordering depends on rendering engine behavior; document order is correct but visual confirmation needed"
---

# Phase 8: Straight Rail Rendering Verification Report

**Phase Goal:** Users see continuous vertical colored lines connecting commits in each branch, with all active lanes drawn through every row
**Verified:** 2026-03-09T21:30:00Z
**Status:** human_needed
**Re-verification:** Yes -- after fork-edge-fixes (commit 5e2e239). Previous verification was stale due to significant backend algorithm changes.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each branch has a continuous vertical colored line from tip to base, with no gaps between rows at any zoom level | VERIFIED | `straightEdges` filtered from `commit.edges` (LaneSvg.svelte:19-21), each renders `<line>` with y1=-0.5, y2=rowHeight+0.5 for 0.5px overlap (lines 58-66). Branch tips use `y1={cy}` via `commit.is_branch_tip` check (line 60) to stop rail at dot center. Backend emits Straight edges for pass-through lanes AND for child-to-parent lane continuation (graph.rs:155-194), keeping lanes active between fork child and fork parent (graph.rs:167-178). |
| 2 | Every commit row draws rails for all active branches passing through that row, not just the branch owning the commit | VERIFIED | Backend Phase 2 (graph.rs:99-135) iterates all `active_lanes` and emits Straight pass-through edges for every occupied lane other than the current commit's column. Frontend iterates ALL `straightEdges` without filtering by commit ownership (LaneSvg.svelte:57-67). Fork-in lanes now stay active between child and parent rows (graph.rs:167-178), emitting straight edges on intermediate rows. |
| 3 | A branch maintains the same lane color from tip to base -- the color does not change or jump between commits | VERIFIED | Backend assigns color via `lane_colors` HashMap (graph.rs:40), seeded per-branch at column allocation (graph.rs:82-83, 215-216). `edge.color_index` propagated from `lane_colors.get(&col)` for each edge (graph.rs:111,125,157,172,188,238). Frontend `laneColor()` maps index to `var(--lane-N)` CSS variables consistently (LaneSvg.svelte:15), used for rails (line 63), connection paths (line 74), and dot (line 85). |
| 4 | Commit dots render on top of lane lines (not behind or clipped by them) | VERIFIED | SVG document order in LaneSvg.svelte: Layer 1 `<line>` elements (lines 57-67), Layer 2 `<path>` elements (lines 70-78), Layer 3 `<circle>` element (lines 81-86). SVG spec renders later elements on top of earlier ones. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/app.css` | Vivid 8-color dark-theme lane palette with high contrast against #0d1117 | VERIFIED | 33 lines. All 8 `--lane-N` CSS custom properties defined (lines 13-20): #58a6ff (bright blue), #f78166 (warm orange), #f778ba (vivid pink), #d2a8ff (soft purple), #7ee787 (bright green), #ffa657 (amber), #79c0ff (sky blue), #ff7b72 (coral red). Contains `--lane-0` pattern. |
| `src/components/LaneSvg.svelte` | Full lane rendering: vertical rails, Manhattan-routed merge/fork edges, commit dot | VERIFIED | 87 lines (exceeds 60 min_lines). Three-layer SVG: `straightEdges`/`connectionEdges` derived filters, `buildEdgePath()` for Manhattan routing of all 4 edge types (MergeLeft/Right, ForkLeft/Right), commit dot circle. Uses `is_branch_tip` for branch tip rail truncation. |
| `src-tauri/src/git/graph.rs` | Backend lane algorithm with fork edges on parent row, is_branch_tip, pass-through edges | VERIFIED | Fork-in detection at lines 100-135: identifies lanes where `occupant == oid` (child set lane to point to parent), emits ForkLeft/ForkRight edge from parent's column to branch column. `is_branch_tip` computed at line 94. Branch lanes stay active between child and parent (lines 167-178). All 50 tests pass including `branch_fork_topology`. |
| `src/lib/types.ts` | TypeScript types with is_branch_tip field on GraphCommit | VERIFIED | `is_branch_tip: boolean` at line 38 of GraphCommit interface. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `LaneSvg.svelte` | `commit.edges` | iterates edge array, filters by from_column === to_column for rails vs connection edges | WIRED | `commit.edges.filter((e) => e.from_column === e.to_column)` at line 20; `commit.edges.filter((e) => e.from_column !== e.to_column)` at line 24 |
| `LaneSvg.svelte` | `src/app.css` | laneColor() helper returns var(--lane-N) CSS custom properties | WIRED | `laneColor()` returns `` `var(--lane-${idx % 8})` `` at line 15; used at lines 63, 74, 85 for rails, edges, and dot |
| `CommitRow.svelte` | `LaneSvg.svelte` | passes commit and maxColumns props | WIRED | `import LaneSvg from './LaneSvg.svelte'` at line 3; `<LaneSvg {commit} {maxColumns} />` at line 26 |
| `CommitGraph.svelte` | `CommitRow.svelte` | passes commit and maxColumns from GraphResponse | WIRED | `maxColumns = response.max_columns` at lines 41/60; `<CommitRow {commit} onselect={oncommitselect} {maxColumns} />` at line 155 |
| `graph.rs` (backend) | `types.rs` (backend) | GraphCommit struct with is_branch_tip, edges, color_index | WIRED | `per_oid_data.insert(oid, (col, edges, commit_color, is_branch_tip))` at line 254; `GraphCommit { ... is_branch_tip, ... }` at lines 269-285 |
| `LaneSvg.svelte` | `commit.is_branch_tip` | Controls branch tip rail truncation (y1 = cy instead of -0.5) | WIRED | `y1={commit.is_branch_tip && edge.from_column === commit.column ? cy : -0.5}` at line 60 |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| LANE-01 | 08-01-PLAN.md | User sees continuous vertical colored lines connecting commits in the same branch | SATISFIED | Straight edges render as continuous `<line>` elements with 0.5px overlap. Branch tips truncate at dot center via `is_branch_tip`. Fork-in lanes stay active on intermediate rows (graph.rs:167-178). |
| LANE-03 | 08-01-PLAN.md | User sees all active branch lanes drawn through every commit row, not just that branch's own commits | SATISFIED | Backend emits pass-through Straight edges for all occupied lanes (graph.rs:99-135). Fork-in lanes maintain pass-through visibility between child and parent. Frontend renders all `straightEdges` without ownership filtering. |
| LANE-04 | 08-01-PLAN.md | User sees consistent lane colors per branch from tip to base (color does not jump between commits) | SATISFIED | `lane_colors` HashMap provides consistent color_index per column. Colors assigned at branch creation and propagated through all edges. |

No orphaned requirements -- all Phase 8 requirement IDs in REQUIREMENTS.md (LANE-01, LANE-03, LANE-04) are accounted for in the plan and marked complete in REQUIREMENTS.md traceability table.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No anti-patterns detected |

No TODO/FIXME/HACK/PLACEHOLDER comments found in any Phase 8 files. No empty implementations. No console.log-only handlers. No stub returns.

Pre-existing issues (not Phase 8):
- `bun run check` exits with code 1 due to SvelteVirtualList type mismatch in CommitGraph.svelte (line 147) -- confirmed present before Phase 8, unrelated.
- Accessibility warnings in CommitRow.svelte and FileRow.svelte -- pre-existing, unrelated.

### Human Verification Required

All automated checks pass. The following items require human visual verification:

### 1. Continuous Vertical Rails (No Gaps)

**Test:** Run `bun run tauri dev`, open a repository with branches, and scroll through commit history. Zoom in/out with Cmd+/Cmd-.
**Expected:** Each branch shows a continuous vertical colored line from tip to base. Branch tip rails start at the dot center (not extending above). No visible hairline gaps between rows at any zoom level.
**Why human:** Sub-pixel rendering gaps depend on the browser/webview rendering engine and zoom level. The 0.5px overlap is implemented but visual correctness cannot be verified programmatically.

### 2. Fork Edge Rendering (Post-Fix)

**Test:** Open a repository with unmerged branches (e.g., topic branches forking from main). Look at the parent commit where a branch diverges.
**Expected:** Fork edges start at the parent commit dot, go horizontal toward the branch column, arc upward with a rounded corner, and extend to the top of the row. The branch rail then appears as a continuous straight pass-through in the rows above, terminating at the branch tip dot. There should be NO fork edges on the child (branch tip) row itself.
**Why human:** This is the key visual change from commit 5e2e239. The previous approach emitted fork edges on the child row (going downward). The new approach emits them on the parent row (going upward). Visual correctness of this reversal must be confirmed.

### 3. Vivid High-Contrast Lane Colors

**Test:** View the commit graph with multiple active branches.
**Expected:** All 8 lane colors are clearly visible and easily distinguishable against the #0d1117 dark background. No nearly-invisible or hard-to-read colors.
**Why human:** Color contrast and visibility is a visual perception judgment.

### 4. Commit Dots on Top of Rails

**Test:** View commits where the dot overlaps a vertical rail line or connection path.
**Expected:** The commit dot renders visually on top of the rail line and any connection paths, not behind or clipped by them.
**Why human:** Z-ordering in SVG depends on rendering engine behavior; document order is correct but visual confirmation needed.

### 5. Manhattan-Routed Merge/Fork Edges with Rounded Corners

**Test:** Open a repository with merges and forks visible in the commit graph.
**Expected:** Merge connections go horizontal from the commit dot, arc downward with a rounded corner, then vertical to the row bottom. Fork connections go horizontal from the parent dot, arc upward, then vertical to the row top. Corners are smooth 90-degree arcs, not sharp angles.
**Why human:** SVG path rendering of arc commands requires visual inspection to confirm smoothness and correctness.

### Gaps Summary

No gaps found in automated verification. All 4 success criteria from ROADMAP.md are verified at the code level. All 3 requirements (LANE-01, LANE-03, LANE-04) are satisfied. All artifacts exist, are substantive, and are properly wired. All key links are confirmed.

**Post-fork-edge-fix status:** The backend changes from commit 5e2e239 are correctly reflected in both the Rust algorithm (fork edges emitted on parent row via fork-in detection, branch lanes staying active between child and parent for pass-through rails, is_branch_tip field) and the Svelte frontend (fork paths route upward to row top, branch tip rails truncated at dot center). The `branch_fork_topology` test explicitly validates that fork edges appear on the parent (C1) and NOT on the child (B0). All 50 backend tests pass.

---

_Verified: 2026-03-09T21:30:00Z_
_Verifier: Claude (gsd-verifier)_
