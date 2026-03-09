# Feature Landscape: Commit Graph Lane Rendering

**Domain:** DAG commit graph visualization in desktop Git GUI
**Researched:** 2026-03-09
**Overall confidence:** MEDIUM-HIGH (cross-referenced multiple open-source implementations, blog posts with working code, and feature pages from GitKraken/Fork/Sourcetree/Git Extensions/SmartGit)

---

## Table Stakes

Features that users of GitKraken, Fork, Sourcetree, and similar tools consider baseline. Missing any of these and the graph feels "broken" or "toy-like."

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| T1 | **Vertical lane rails (continuous colored lines)** | Every commercial Git GUI draws continuous vertical lines per active lane. Without them, users cannot visually trace which commits belong together. Dots alone force mental reconstruction of the DAG topology. | Medium | The current LaneSvg.svelte renders only a dot -- no lines at all. The Rust backend already computes edges with `from_column`, `to_column`, and `EdgeType` (Straight, ForkLeft, ForkRight, MergeLeft, MergeRight). The SVG just needs to render them. Per-row inline SVGs must have lines that extend from `y=0` to `y=rowHeight` so adjacent rows visually connect. |
| T2 | **Smooth curved edges for merge/fork connections** | GitKraken, Fork, and Sourcetree all draw smooth curves (not jagged diagonals) when a lane merges into or forks from another lane. Jagged 45-degree diagonals look amateurish. Cubic bezier curves are the standard approach. | Medium | SVG `<path>` with cubic bezier `C` command. For a fork/merge from column A to column B across one row: `M ax 0 C ax cy, bx cy, bx rowHeight` where `cy` is a control point offset (typically 40-60% of rowHeight). The DoltHub implementation uses weighted interpolation coefficients (0.1/0.9 for control points). |
| T3 | **Lane color consistency per branch** | Each branch rail should maintain one color from tip to base. If color jumps between commits on the same lane, it confuses users into thinking it is a different branch. | Low | Current code uses `color_index: column_number % 8`. This is already lane-consistent since a branch stays in one column. The color only needs to persist when a lane merges into another lane (the receiving lane keeps its original color). Already handled by `color_index` on each edge. |
| T4 | **Lane packing (reclaim freed columns)** | When a branch merges, its column becomes available. Without packing, the graph grows ever-wider (one new column per branch, never reclaimed). Wide graphs push the commit message off-screen. | Medium | The existing Rust algorithm already does this: `active_lanes[col] = None` when a branch terminates, and new branches scan for `None` slots before appending. Verify this works correctly with nested merges. The "straight branches" approach from pvigier's research sets positions to `nil` rather than removing them, which is exactly what the current code does. |
| T5 | **Merge commit visual distinction** | Users need to instantly distinguish merge commits from regular commits. GitKraken uses a larger node; Fork uses a double circle; Mermaid uses a filled double circle; gitk uses a diamond. A merge commit with the same visual as a normal commit hides important topology. | Low | Current code already sets `is_merge` and renders a larger circle (r=6 vs r=4) with a background-colored stroke. This is adequate. Consider also filling merge dots with background color and using a thicker colored stroke (hollow dot) for stronger distinction. |
| T6 | **Pass-through lanes (other active lanes render through each row)** | When a row's commit is on column 2, columns 0, 1, 3, 4 etc. that have active lanes must draw straight vertical lines through that row. Without pass-through lines, the graph appears to have "gaps" where long-running branches momentarily vanish. | Low | The Rust algorithm already emits `Straight` edges for all other active lanes at each commit row. The SVG just needs to draw a vertical line for each `Straight` edge where `from_column == to_column`. |
| T7 | **Correct HEAD-chain column 0 pinning** | HEAD's first-parent chain should always occupy column 0 (leftmost). This is the user's primary reference point. GitKraken, Fork, and Sourcetree all pin the current branch to the left. | Low | Already implemented in Rust: `head_chain` pre-reserves column 0 for all first-parent ancestors of HEAD. Branch tips that diverge from HEAD get columns >= 1. Verified by `branch_fork_topology` test. |
| T8 | **WIP row with lane connection** | The "uncommitted changes" / WIP row at the top should connect to the HEAD commit via a lane line (typically dashed or in a muted color). Without it, the WIP row floats disconnected above the graph. vscode-git-graph and GitKraken both show uncommitted changes connected to the graph. | Low | Current WIP row has a hollow circle at column 0 but no line connecting down to the first commit. Need a dashed vertical line segment from WIP dot to first commit's row. |

---

## Differentiators

Features present in top-tier tools (GitKraken, Fork) but absent from many others. Implementing them elevates the graph from "functional" to "polished."

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D1 | **Crossing-lane detection with visual offset** | When two edges cross (a merge line crosses over an active lane), the crossing should be visually indicated -- either a small gap in the background line, or a slight curve to suggest "over/under." GitKraken handles this cleanly; many simpler tools just let lines overlap and become unreadable. | High | Requires detecting when a merge/fork edge from column A to column B passes through intermediate columns. For each intermediate column that has an active lane, either: (a) draw the crossing edge with a small gap/bridge at the intersection, or (b) route the edge to avoid the crossing entirely. Option (a) is simpler. |
| D2 | **Ref label connection to graph lane** | Branch/tag pills should visually align with or connect to their lane's color. GitKraken colors ref pills to match their lane; Fork draws a small colored bar connecting the pill to the graph. This removes the cognitive step of "which branch is this pill for?" | Medium | Current RefPill uses a fixed-width 120px column to the left of the graph. Could add a small colored dot or bar between the pill and the graph, colored to match `lane-N`. Or color the pill's border/background to match. |
| D3 | **Collapsible merge trains** | For long merge histories (especially merge-heavy workflows like GitHub PRs), the ability to collapse a merge commit's second-parent chain keeps the graph compact. Fork recently added expand/collapse merge commits via click or keyboard arrow keys. | High | Requires UI state tracking (which merges are collapsed), modifying the commit list to hide/show child commits of the collapsed merge's second parent chain, and redrawing lane assignments. This is a significant feature best deferred to after initial lane rendering ships. |
| D4 | **Graph width control (compact mode)** | GitKraken allows resizing the graph column width, even down to a single column. Useful for repos with many branches where the graph would otherwise consume half the screen. | Medium | Change `laneWidth` from fixed 12px to a configurable value. Add a drag handle on the graph column border, or a compact/normal toggle. The SVG width already derives from `(column + 1) * laneWidth`. |
| D5 | **Dim/ghost merge commits** | GitKraken offers "dim merge commits" to reduce visual noise. In merge-heavy repos, merge commits can outnumber real work commits 2:1. Dimming them (lower opacity) lets users focus on actual code changes. | Low | CSS opacity on CommitRow when `commit.is_merge === true`. Could be a toggle in the UI or always-on with hover-to-reveal. |
| D6 | **Author avatars on commit nodes** | GitKraken shows author avatars (Gravatar) on commit nodes. This provides instant visual attribution without reading text. | Medium | Requires Gravatar URL generation from email hash, image caching, and rendering small circular images at the commit node position instead of (or overlaid on) the colored dot. Network dependency makes this a "nice to have." |
| D7 | **Keyboard navigation within graph** | Arrow keys to move selection up/down commits, left/right to navigate merge parents. Fork and Tower are praised for keyboard-driven graph exploration. | Medium | Requires tracking selected commit index, handling ArrowUp/ArrowDown to move selection, scrolling viewport to keep selection visible. ArrowLeft/ArrowRight could follow first-parent vs second-parent chains. |
| D8 | **Animated edge transitions** | When the graph redraws (after commit, branch switch, pull), edges animate smoothly rather than jump. This reduces cognitive disorientation. | Medium | SVG path transitions via CSS `transition` on `d` attribute, or FLIP animation technique. May conflict with virtual scrolling if row DOM nodes are recycled. |
| D9 | **Branch-specific color override** | Let users assign fixed colors to branch names (e.g., "main is always blue, develop is always green"). Sourcetree and SmartGit users request this constantly (Atlassian JIRA SRCTREEWIN-3477 has 20+ votes). | Medium | Requires a small config store mapping branch names to color indices. The Rust algorithm would need to look up branch names when assigning `color_index` instead of just using column number. |

---

## Anti-Features

Features to explicitly NOT build for the lane rendering milestone. Building them now adds complexity that delays shipping or creates maintenance burden without proportional value.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Canvas-based graph rendering** | The current inline SVG per-row approach works well with virtual scrolling, is accessible, allows text selection, and is simpler to implement. Canvas would require a complete rewrite of the rendering layer, custom hit testing, and re-implementing scrolling. The pvigier benchmarks show SVG performance is adequate when only visible rows are rendered (~40 DOM nodes). | Keep inline SVG per row. Only revisit Canvas if SVG proves too slow with 20+ active lanes (unlikely for most repos). |
| **Single-SVG graph column** | Rendering the entire graph as one tall SVG defeats virtual scrolling. Memory grows with commit count. This is how gitgraph.js works and it cannot handle large repos. | Keep per-row SVGs. Lines connect visually because each row's SVG extends from `y=0` to `y=rowHeight`, making adjacent rows seamless. |
| **Octopus merge fan rendering** | Octopus merges (3+ parents) are rare in practice (Linux kernel is the poster child). Building special fan-out rendering for them adds complexity for a case most users never see. The gitgraph.js library was archived without ever implementing it. | Treat octopus merges as multiple binary merge edges. If commit C has parents P1, P2, P3, render three separate merge edges (C->P1, C->P2, C->P3). The existing edge model already supports this -- each parent gets its own `GraphEdge`. |
| **Full-graph layout optimization (minimize crossings globally)** | Global crossing minimization is NP-hard (Sugiyama framework). The topological + time-sorted single-pass algorithm is O(n) and produces good-enough results. GitKraken and Fork also use greedy single-pass approaches, not global optimization. | Keep the greedy single-pass algorithm. If specific topologies produce ugly crossings, fix them with targeted heuristics (e.g., prefer placing first-parent in same column, prefer merging toward column 0). |
| **Horizontal scrolling for wide graphs** | If the graph is so wide it needs horizontal scrolling, the real problem is too many active branches. Horizontal scrolling breaks the mental model of "scroll down = go back in time." | Instead, implement lane packing aggressively and consider compact mode (D4). If a repo genuinely has 30 simultaneous branches, show a condensed view rather than scrolling. |
| **Real-time graph streaming** | Streaming commits into the graph as they are computed (rather than batch loading) adds complexity to lane assignment (you cannot assign lanes without seeing future commits in the topological order). | Keep the current batch approach: compute all lanes in Rust over the full commit set, paginate the results. The existing ~5ms for 10k commits makes streaming unnecessary. |
| **3D or perspective graph views** | Some tools experiment with 3D DAG visualization. It is universally considered less readable than 2D. | 2D flat graph only. |

---

## Feature Dependencies

```
T7: HEAD-chain column 0 pinning (DONE in Rust)
  --> T4: Lane packing (DONE in Rust, needs verification)
      --> T6: Pass-through lanes (Rust emits edges, SVG needs rendering)
          --> T1: Vertical lane rails (SVG rendering of Straight edges)
              --> T2: Smooth curved edges (SVG rendering of Fork/Merge edges)
                  --> T3: Lane color consistency (verified via color_index on edges)
                      --> T5: Merge commit visual distinction (DONE, minor polish)
                          --> T8: WIP row lane connection (new SVG element)

Independent features (can ship in any order after T1+T2):
  D1: Crossing-lane detection (SVG rendering enhancement)
  D2: Ref label connection (CSS/layout change)
  D4: Graph width control (CSS variable change)
  D5: Dim merge commits (CSS opacity toggle)

Require additional infrastructure:
  D3: Collapsible merge trains (UI state + commit list filtering + lane recalculation)
  D6: Author avatars (network + caching)
  D7: Keyboard navigation (focus management + scroll control)
  D9: Branch-specific colors (config store + Rust algorithm change)
```

---

## MVP Recommendation (v0.2 Commit Graph Milestone)

**Must ship -- these define "GitKraken-quality" graph:**

1. **T1: Vertical lane rails** -- The single biggest visual leap from "dots only" to "real graph." Everything else builds on this.
2. **T2: Smooth bezier curves for merge/fork** -- Straight diagonals are acceptable as a stepping stone, but bezier curves are what make the graph feel professional. Ship together with T1 if possible.
3. **T6: Pass-through lanes** -- Without these, long-running branches disappear between their commits. The Rust data is already there.
4. **T5: Merge commit visual distinction** -- Already partially done. Polish the hollow-dot style.
5. **T8: WIP row lane connection** -- Small effort, big visual coherence payoff.
6. **T3: Lane color consistency** -- Already working via `color_index`. Verify it holds across complex topologies.
7. **T4: Lane packing** -- Already implemented in Rust. Verify with real-world repos (linux kernel, etc.).
8. **T7: HEAD pinning** -- Already implemented. Verify.

**Ship soon after (high-value, low-effort):**

9. **D5: Dim merge commits** -- CSS-only change, reduces noise in merge-heavy repos.
10. **D2: Ref label color connection** -- Small visual polish that aids branch identification.
11. **D4: Graph width control** -- Make `laneWidth` adjustable via the pane resize handle.

**Defer to v0.3+:**

- D1: Crossing-lane detection (complex, edge case)
- D3: Collapsible merge trains (significant new feature)
- D6: Author avatars (network dependency)
- D7: Keyboard navigation (covered by separate milestone)
- D8: Animated transitions (polish)
- D9: Branch-specific colors (requires config UI)

---

## Edge Cases to Handle

These are the topologies that break naive graph implementations. The lane algorithm must handle them correctly or the graph will have visual artifacts.

### Octopus merges (3+ parents)
**Frequency:** Rare (Linux kernel, some CI workflows).
**Expected behavior:** Multiple merge edges fan out from the commit node to each parent lane. Each edge uses the parent lane's color. The commit node should be visually distinct (larger or different shape).
**Current handling:** The Rust algorithm iterates all parents and creates a `GraphEdge` per parent. This should work out of the box. Test with a synthetic 4-parent merge.

### Long-running branches (100+ commits without merge)
**Frequency:** Common in monorepos, long-lived feature branches.
**Expected behavior:** The lane stays in the same column for the entire run. Pass-through lines must be continuous. Color must not change.
**Risk:** If the virtual scrolling buffer is too small, the lane might appear to "start from nowhere" when the branch tip scrolls off screen. Ensure the SVG always draws pass-through lines for all active lanes regardless of whether the branch tip is visible.

### Criss-crossing lanes
**Frequency:** Common in repos with multiple parallel branches that merge in different orders.
**Expected behavior:** When branch A merges into main, then branch B (which was to the right of A) merges into main, the remaining branches shift left to fill the gap. This can cause visual "crossing" where a lane appears to jump columns.
**Current handling:** The Rust algorithm places each commit in its pre-assigned column. If a parent was already claimed at a different column, it emits a fork/merge edge. The visual crossing is implicit in the edge rendering. No explicit crossing detection exists yet.

### Diamond merges (feature branch merges, then another branch merges the same base)
**Frequency:** Very common (standard PR workflow).
**Expected behavior:** Two edges converge at the merge commit, creating a diamond shape. The merge edges should curve smoothly inward. The lane that terminates should free its column.
**Current handling:** Covered by the existing merge edge logic. The column is freed via `active_lanes[col] = None`.

### Pagination boundary continuity
**Frequency:** Every time the user scrolls past a 200-commit page boundary.
**Expected behavior:** Lanes must be visually continuous across page boundaries. There must be no "break" where one page ends and the next begins.
**Current handling:** The Rust algorithm runs over ALL oids (not just the page), so lane assignments are globally consistent. The page is just a slice of the pre-computed data. This is correct. The SVG per-row approach handles this naturally since each row independently draws its edges based on pre-computed column assignments.

### Root commits (no parents)
**Frequency:** Once per repo (initial commit), or multiple times in repos with merged unrelated histories.
**Expected behavior:** The lane terminates (no downward line from the dot). The column is freed for reuse.
**Current handling:** The Rust algorithm emits no `Straight` edge for root commits (tested in `linear_topology` test: "root commit should not have self-straight edge"). Correct.

### Detached HEAD
**Frequency:** Occasional (during rebase, bisect, tag checkout).
**Expected behavior:** The HEAD indicator should still pin to column 0. The WIP row should still connect to the checked-out commit.
**Current handling:** The `head_chain` computation follows `repo.head()` which works for detached HEAD. Should still work correctly.

---

## Visual Behavior Specifications

### Lane rail rendering (T1 + T6)
- **Straight edges:** Vertical line from `(cx, 0)` to `(cx, rowHeight)` where `cx = column * laneWidth + laneWidth / 2`
- **Line width:** 2px (standard across GitKraken, Fork, vscode-git-graph)
- **Line color:** `var(--lane-{color_index % 8})`
- **Line cap:** `round` for smooth visual joins between rows

### Bezier curve rendering (T2)
- **ForkLeft/ForkRight (child diverges from parent's lane):**
  Start at child's column, curve to parent's column.
  `M childX 0 C childX controlY, parentX controlY, parentX rowHeight`
  where `controlY = rowHeight * 0.4` (the curve begins straight, then bends)
- **MergeLeft/MergeRight (merge commit connects to second parent's lane):**
  Start at merge commit's column, curve to parent's column.
  Same bezier formula but semantically the merge edge color should use the parent lane's color (the branch being merged in).
- **Multi-row edges:** If a fork/merge spans more than one row (parent is not the immediately next row), the curve should span across multiple rows. With per-row SVGs, this means: first row gets a curve starting at the commit, intermediate rows get a diagonal segment, final row gets a curve ending at the parent. Alternatively, let each per-row SVG draw its segment of the overall curve using the `from_column` and `to_column` data.

### Commit node rendering (T5)
- **Normal commit:** Filled circle, r=4, colored by lane
- **Merge commit:** Hollow circle (filled with background), r=5-6, stroke=2px with lane color. This is the most common approach across tools (GitKraken, vscode-git-graph)
- **HEAD commit:** Same as normal but consider adding a small ring or glow effect
- **WIP node:** Hollow circle with dashed stroke, r=4, muted lane color

### Color palette
- 8 cycling colors is standard (GitKraken uses 8, vscode-git-graph uses 8-10)
- Current palette is well-chosen for dark backgrounds with good contrast
- Color is assigned by column number, which means a lane's color is stable as long as it stays in the same column
- When a lane merges and frees its column, a new branch reusing that column gets the same color -- this is expected behavior and matches GitKraken

---

## Sources

### HIGH confidence (official docs, source code, working implementations)
- [pvigier's Commit Graph Drawing Algorithms](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html) -- comprehensive algorithm comparison with benchmarks
- [DoltHub: Drawing a Commit Graph](https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/) -- working SVG implementation with bezier curve control point formulas
- [Git Extensions Revision Graph wiki](https://github.com/gitextensions/gitextensions/wiki/Revision-Graph) -- architecture of lane-based graph rendering
- [vscode-git-graph issue #194: Color and position mapping](https://github.com/mhutchie/vscode-git-graph/issues/194) -- maintainer explanation of why globally consistent colors are technically hard
- [vscode-git-graph issue #254: Branch colors on commits](https://github.com/mhutchie/vscode-git-graph/issues/254) -- user expectations for color visibility near commit messages
- Trunk codebase: `src-tauri/src/git/graph.rs`, `src/components/LaneSvg.svelte`, `src/components/CommitRow.svelte` -- current implementation

### MEDIUM confidence (feature pages, cross-referenced claims)
- [GitKraken Commit Graph features page](https://www.gitkraken.com/features/commit-graph) -- visual features and customization options
- [SmartGit branch-line coloring discussion](https://smartgit.userecho.com/communities/1/topics/6-log-make-branch-line-coloring-easier-to-understand-sg-11160) -- color assignment strategies and user confusion patterns
- [Sourcetree JIRA SRCTREEWIN-3477](https://jira.atlassian.com/browse/SRCTREEWIN-3477) -- stable branch color demand
- [gitgraph.js octopus merge issue #204](https://github.com/nicoespeon/gitgraph.js/issues/204) -- challenges of multi-parent visualization

### LOW confidence (single source, unverified)
- [Hacker News discussion on graph algorithms](https://news.ycombinator.com/item?id=21079643) -- anecdotal tool comparisons
- [git-graph-drawing collection](https://github.com/indigane/git-graph-drawing) -- catalog of implementations without detailed analysis
