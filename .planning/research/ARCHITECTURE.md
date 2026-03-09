# Architecture Patterns

**Domain:** Commit graph lane rendering for Tauri 2 + Svelte 5 + Rust desktop Git GUI
**Researched:** 2026-03-09
**Focus:** Integrating GitKraken-quality lane rendering into the existing per-row inline SVG architecture
**Confidence:** HIGH -- existing codebase is well-understood, patterns verified against multiple open-source implementations

---

## Existing Architecture (Current State)

The current system already has the right bones. The Rust algorithm (`graph.rs`) performs a single-pass O(n) walk over all commits, assigning each commit to a column and emitting a `Vec<GraphEdge>` per commit. The frontend receives paginated slices of `Vec<GraphCommit>` and renders each row as an independent inline `<svg>` inside a virtual scroll list.

**What works and stays unchanged:**
- Rust-side lane algorithm runs over ALL commits for lane continuity, paginated slices served from `CommitCache`
- Virtual scrolling with `@humanspeak/svelte-virtual-list` (~40 DOM nodes regardless of history size)
- Per-row inline SVG approach (not Canvas, not one giant SVG)
- 8-color CSS custom property palette (`--lane-0` through `--lane-7`)
- `CommitRow.svelte` layout: RefPills (120px) | LaneSvg | Message

**What the current LaneSvg renders:** Only a commit dot (circle). No lane lines, no edges, no curves. This was a deliberate v0.1 decision -- lanes were removed due to visual bugs, with the plan to revisit in v0.2.

**What the Rust algorithm already provides but the frontend ignores:**
- `edges: Vec<GraphEdge>` per commit, including pass-through `Straight` edges for active lanes crossing each row
- `from_column`, `to_column`, `edge_type`, `color_index` per edge
- All five edge types: `Straight`, `ForkLeft`, `ForkRight`, `MergeLeft`, `MergeRight`

---

## Recommended Architecture

### Design Principle: Minimal Data Changes, Maximum Visual Impact

The existing Rust algorithm already emits nearly everything needed. The key insight is that `walk_commits()` already generates pass-through `Straight` edges for every active lane crossing each row (lines 80-91 of graph.rs). This means the frontend has the data to draw continuous lane rails -- it just needs to render them.

The primary changes are:
1. **One new field from Rust:** `max_columns` (the widest the graph gets across all commits) -- needed for consistent SVG width
2. **LaneSvg.svelte rewrite:** From "dot only" to "full lane rendering with edges and dot"
3. **No changes to CommitRow, CommitGraph, CommitCache, or the IPC layer**

### Architecture Diagram

```
Rust (graph.rs) -- MINOR CHANGE
  walk_commits() already emits:
    - commit.column (which lane this commit sits in)
    - commit.edges[] with pass-through Straight edges for ALL active lanes
    - ForkLeft/Right and MergeLeft/Right edges with from/to columns
  NEW: return max_columns alongside Vec<GraphCommit>

CommitCache (state.rs) -- MINOR CHANGE
  Store (Vec<GraphCommit>, usize) instead of Vec<GraphCommit>
  The usize is max_columns

get_commit_graph (history.rs) -- MINOR CHANGE
  Return { commits: Vec<GraphCommit>, max_columns: usize }

CommitGraph.svelte -- MINOR CHANGE
  Pass maxColumns to each CommitRow

CommitRow.svelte -- MINOR CHANGE
  Pass maxColumns to LaneSvg

LaneSvg.svelte -- FULL REWRITE
  Renders: pass-through rails + fork/merge curves + commit dot
  Uses maxColumns for consistent SVG width across all rows
```

---

## Component Boundaries

### Modified Components

| Component | Change Type | What Changes | Why |
|-----------|-------------|-------------|-----|
| `graph.rs` | Minor | Track and return `max_columns` | Consistent SVG width across all rows |
| `types.rs` | Minor | Add `GraphResponse` struct wrapping `Vec<GraphCommit>` + `max_columns: usize` | IPC needs the new field |
| `types.ts` | Minor | Add `GraphResponse` interface | Mirror Rust type |
| `history.rs` | Minor | Return `GraphResponse` instead of `Vec<GraphCommit>` | Carry `max_columns` to frontend |
| `state.rs` | Minor | `CommitCache` stores `(Vec<GraphCommit>, usize)` | Cache includes max_columns |
| `CommitGraph.svelte` | Minor | Extract `maxColumns` from response, pass as prop | Thread data to LaneSvg |
| `CommitRow.svelte` | Minor | Accept and forward `maxColumns` prop | Thread data to LaneSvg |
| `LaneSvg.svelte` | **Full rewrite** | Render lane rails, bezier curves, commit dot | The core visual change |

### New Types

```rust
// types.rs -- add this struct
#[derive(Debug, Serialize, Clone)]
pub struct GraphResponse {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
}
```

```typescript
// types.ts -- add this interface
export interface GraphResponse {
  commits: GraphCommit[];
  max_columns: number;
}
```

---

## Data Flow

### What the Rust Algorithm Already Provides Per Row

For a commit at column 2 in a graph with 4 active lanes, the existing `edges` array looks like:

```
Row for commit C (column=2, is_merge=true):
  edges: [
    { from: 0, to: 0, type: Straight, color: 0 },   // Lane 0 passes through
    { from: 1, to: 1, type: Straight, color: 1 },   // Lane 1 passes through
    { from: 2, to: 2, type: Straight, color: 2 },   // First-parent continuation
    { from: 2, to: 3, type: MergeRight, color: 3 }, // Merge edge to lane 3
    { from: 3, to: 3, type: Straight, color: 3 },   // Lane 3 passes through
  ]
```

This is already sufficient to render:
- Vertical lines at columns 0, 1, 3 (pass-through rails)
- A vertical line at column 2 (first-parent continuation downward)
- A bezier curve from column 2 to column 3 (merge connection)
- A commit dot at column 2

### What max_columns Adds

Without `max_columns`, each row's SVG width is `(commit.column + 1) * laneWidth`, which causes the graph column to have inconsistent width across rows. A commit on column 0 gets a 12px-wide SVG while one on column 5 gets 72px. This makes the message column jump horizontally as you scroll.

With `max_columns`, every row renders `max_columns * laneWidth` wide, keeping the message column aligned. The Rust algorithm already knows this value (it is `active_lanes.len()` at its maximum during the walk).

### Data Flow Sequence

```
1. open_repo() -> walk_commits() returns (Vec<GraphCommit>, max_columns)
2. CommitCache stores (Vec<GraphCommit>, max_columns)
3. get_commit_graph returns { commits: [...], max_columns: N }
4. CommitGraph.svelte stores maxColumns in $state
5. Each CommitRow receives maxColumns as prop
6. LaneSvg receives commit + maxColumns, renders full lane graphic
```

---

## LaneSvg Rendering Architecture (The Core Change)

### SVG Structure Per Row

Each row's SVG has three visual layers, rendered in order (back to front):

```
<svg width={maxColumns * laneWidth} height={rowHeight}>
  <!-- Layer 1: Pass-through vertical rails (background) -->
  <!-- Layer 2: Fork/merge bezier curves -->
  <!-- Layer 3: Commit dot (foreground) -->
</svg>
```

### Recommended Dimensions

| Parameter | Current | Recommended | Rationale |
|-----------|---------|-------------|-----------|
| `laneWidth` | 12px | 16px | 12px is too tight for curves; 16px matches GitKraken density |
| `rowHeight` | 26px | 26px (unchanged) | Works well, no reason to change |
| Dot radius (normal) | 4px | 4px (unchanged) | Proportional to 16px lanes |
| Dot radius (merge) | 6px | 5px | 6px was oversized; 5px with ring stroke looks better at 16px |
| Line stroke width | n/a | 2px | Standard across all git GUIs |
| Curve stroke width | n/a | 2px | Same as rails for visual consistency |

### SVG Rendering by Edge Type

**Pass-through rails (Straight edges where from_column === to_column and from_column !== commit.column):**

These are vertical lines spanning the full row height. They create the continuous "railroad track" effect.

```svg
<line
  x1={col * 16 + 8} y1={0}
  x2={col * 16 + 8} y2={26}
  stroke="var(--lane-{colorIndex % 8})"
  stroke-width="2"
/>
```

**First-parent continuation (Straight edge where from_column === commit.column):**

A vertical line from the commit dot downward (to the next row where the parent lives). This extends from the vertical center of the row to the bottom edge.

```svg
<line
  x1={col * 16 + 8} y1={13}
  x2={col * 16 + 8} y2={26}
  stroke="var(--lane-{colorIndex % 8})"
  stroke-width="2"
/>
```

Additionally, a line from the top of the row to the commit dot (the incoming rail from the child above):

```svg
<line
  x1={col * 16 + 8} y1={0}
  x2={col * 16 + 8} y2={13}
  stroke="var(--lane-{colorIndex % 8})"
  stroke-width="2"
/>
```

**Fork edges (ForkLeft / ForkRight):**

A cubic bezier curve from the commit dot's vertical center to the target column at the bottom of the row. The curve must exit the commit dot vertically (not at an angle) and arrive at the target column vertically. This requires the control points to be vertically aligned with the endpoints.

```svg
<!-- ForkLeft: commit at col 3, parent at col 1 -->
<path
  d="M {3*16+8} {13} C {3*16+8} {13 + 26*0.4}, {1*16+8} {26 - 26*0.4}, {1*16+8} {26}"
  fill="none"
  stroke="var(--lane-{colorIndex % 8})"
  stroke-width="2"
/>
```

The general formula for a fork/merge curve:

```
M {startX} {startY}
C {startX} {startY + rowHeight * 0.4},
  {endX}   {endY - rowHeight * 0.4},
  {endX}   {endY}
```

Where the control points are 40% of row height away from the endpoints, keeping the curve tangent vertical at both ends. This creates the smooth S-curve that characterizes GitKraken's rendering. The 0.4 factor was derived from vscode-git-graph's implementation (which uses 0.8 of grid.y for the control point offset -- equivalent to 0.4 of the full row span when the curve spans one row).

**Merge edges (MergeLeft / MergeRight):**

Identical curve shape to fork edges. The semantic difference (merge vs fork) affects only the Rust algorithm's edge classification, not the rendering. Both use the same bezier formula. The color comes from `color_index` (which the Rust algorithm sets to the target column's color for merges).

```svg
<!-- MergeRight: commit at col 0, secondary parent at col 2 -->
<path
  d="M {0*16+8} {13} C {0*16+8} {13 + 26*0.4}, {2*16+8} {26 - 26*0.4}, {2*16+8} {26}"
  fill="none"
  stroke="var(--lane-{colorIndex % 8})"
  stroke-width="2"
/>
```

**Commit dot (always on top):**

```svg
<!-- Normal commit -->
<circle cx={col * 16 + 8} cy={13} r={4}
  fill="var(--lane-{col % 8})" />

<!-- Merge commit: filled circle with contrasting ring -->
<circle cx={col * 16 + 8} cy={13} r={5}
  fill="var(--lane-{col % 8})"
  stroke="var(--color-bg)" stroke-width="2" />
```

### Cross-Row Visual Continuity

The critical insight for per-row SVG rendering: **visual continuity is achieved by having each row draw its pass-through rails from y=0 to y=rowHeight (full height)**. When rows are stacked vertically with no gap, the rails appear as one continuous line.

This works because:
1. The Rust algorithm emits `Straight` pass-through edges for every active lane in every row
2. Each row draws these as full-height vertical lines
3. Adjacent rows' lines are pixel-aligned (same x coordinate, touching y coordinates)
4. No gap between rows (rowHeight is exact, no border/margin/padding between row SVGs)

For fork/merge curves that cross columns, the curve in row N exits at the bottom of the row toward the target column, and the target column's pass-through rail in row N+1 picks up from the top. The bezier curve's endpoint is at `y=rowHeight` which pixel-aligns with the next row's `y=0`.

### Edge Case: Root Commits and Branch Tips

A root commit (no parents) should NOT have a downward rail from the dot. The Rust algorithm already handles this -- root commits have no `Straight` self-edge.

A branch tip (no children pointing to it in the visible range) should have the rail from `y=0` to the dot at `y=13`, but NOT from `y=0` to `y=26`. This is already handled: the pass-through edges only exist for rows where the lane is active, and the Rust algorithm marks the lane as consumed when the commit occupies it.

### Edge Case: Incoming Rail Above Commit Dot

When a commit has children above it, there should be a rail segment from `y=0` down to `y=13` (the dot center). This comes from the fact that the row above emits a pass-through or fork/merge edge whose endpoint is at the bottom of that row, and the current row needs to connect from the top to the dot.

The Rust algorithm does NOT currently emit an explicit "incoming from above" edge for the commit's own column. The pass-through `Straight` edge for the commit's own lane exists in the PARENT rows (where the lane is tracked as active), but in the commit's own row, the lane is consumed. The rendering logic should therefore: draw a line from `y=0` to `y=13` at `commit.column` for any non-tip commit (i.e., any commit that is not the first commit at that column). The simplest approach: if any edge has `to_column === commit.column` in a PREVIOUS row, the current row should draw the incoming segment. But since we render per-row without knowledge of other rows, use this heuristic: **always draw the incoming rail from y=0 to y=cy at the commit's column, UNLESS the commit has no Straight pass-through edge at its own column in the PREVIOUS row**. Since we cannot look at the previous row, the pragmatic approach is: always draw it. The only case where it is wrong (a branch tip appearing for the first time) can be handled by adding a boolean `is_branch_tip` to `GraphCommit`.

**Recommended approach:** Add `is_branch_tip: bool` to `GraphCommit` in Rust. Set it to `true` when the commit's column was freshly allocated (not found in `pending_parents`). When `is_branch_tip` is true, do NOT draw the incoming rail from y=0 to the dot. Otherwise, always draw it.

---

## Revised Rust Algorithm Changes

### Change 1: Track max_columns

In `walk_commits()`, after the main loop:

```rust
let max_columns = active_lanes.len(); // Already computed; just capture it
```

Return this alongside the commits in a `GraphResponse` struct.

### Change 2: Add is_branch_tip to GraphCommit

During the per-oid loop, when a commit's column is freshly allocated (not from `pending_parents`), mark it as a branch tip:

```rust
let is_branch_tip = !pending_parents.contains_key(&oid);
```

Add `pub is_branch_tip: bool` to `GraphCommit` struct and populate it.

### Change 3: First-parent continuation incoming edge

Currently the algorithm emits a `Straight` edge for first-parent continuation (downward from the commit to its first parent). But for the incoming rail (from the row above down to the commit dot), there is no explicit edge. The rendering handles this via the `is_branch_tip` flag: if false, draw the incoming segment; if true, skip it.

No additional changes to the edge emission logic are needed.

---

## Patterns to Follow

### Pattern 1: Rendering Edges by Classification

Classify each edge in `commit.edges` before rendering:

```typescript
type RenderEdge =
  | { kind: 'passthrough'; column: number; colorIndex: number }
  | { kind: 'continuation'; column: number; colorIndex: number }
  | { kind: 'curve'; fromCol: number; toCol: number; colorIndex: number };

function classifyEdges(commit: GraphCommit): RenderEdge[] {
  return commit.edges.map(e => {
    if (e.from_column === e.to_column && e.from_column !== commit.column) {
      return { kind: 'passthrough', column: e.from_column, colorIndex: e.color_index };
    } else if (e.from_column === e.to_column && e.from_column === commit.column) {
      return { kind: 'continuation', column: e.from_column, colorIndex: e.color_index };
    } else {
      return { kind: 'curve', fromCol: e.from_column, toCol: e.to_column, colorIndex: e.color_index };
    }
  });
}
```

This separation makes the rendering logic clean: iterate classified edges, render each kind with its own SVG template.

### Pattern 2: Consistent SVG Width via maxColumns

Every `LaneSvg` instance uses the same width: `maxColumns * laneWidth`. This ensures the commit message column starts at the same horizontal position for every row, eliminating horizontal jitter during scrolling.

### Pattern 3: CSS Custom Properties for Lane Colors

Continue using `var(--lane-{N % 8})` for all stroke and fill colors. This keeps color definitions in CSS and allows future theme customization without touching component code.

### Pattern 4: SVG overflow:visible for Antialiasing

Keep `style="overflow: visible"` on the SVG element. Bezier curves that are antialiased may paint a sub-pixel outside the SVG bounds; `overflow: visible` prevents clipping artifacts at row boundaries.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: One Giant SVG for the Entire Graph
**What:** Rendering all lanes in a single `<svg>` element that spans the full commit history.
**Why bad:** Defeats virtual scrolling. The browser must maintain DOM nodes for every path in the graph, not just visible ones. Memory usage becomes O(n) instead of O(1).
**Instead:** Keep per-row inline SVG. Each row renders only its own edges.

### Anti-Pattern 2: Canvas Rendering
**What:** Switching from SVG to HTML Canvas for lane rendering.
**Why bad:** Canvas requires manual scroll position management, loses text selection, loses CSS variable integration, requires complex hit-testing for interactivity. Canvas IS faster for extremely dense graphs (100+ simultaneous lanes), but git repos rarely exceed 10-15 simultaneous lanes.
**Instead:** Inline SVG per row. The DOM load is ~10-20 SVG elements per row times ~40 visible rows = ~400-800 SVG elements total, well within browser performance bounds.

### Anti-Pattern 3: Rendering Edges in JavaScript Post-Hoc
**What:** Having the frontend compute which lanes are active by scanning adjacent commits.
**Why bad:** The Rust algorithm already tracks active lanes and emits pass-through edges. Duplicating this logic in TypeScript is wasteful and error-prone (especially across pagination boundaries).
**Instead:** Trust the Rust-provided edges. The frontend is purely a renderer -- it maps edges to SVG elements without any graph logic.

### Anti-Pattern 4: Variable Row Height for Merge Rows
**What:** Making merge commit rows taller to accommodate curves.
**Why bad:** Virtual scrolling requires predictable row heights. Variable heights break scroll position calculations and cause visual jumping.
**Instead:** All rows are 26px. Curves are drawn within this height using bezier control points tuned for 26px.

### Anti-Pattern 5: Drawing Curves Across Multiple Rows
**What:** Having a single bezier curve span from a commit in row N to its parent in row N+5.
**Why bad:** Per-row SVG means each SVG only controls its own row. Cross-row curves would require absolute positioning, Z-index management, and would break virtual scrolling.
**Instead:** Fork/merge edges always span exactly ONE row (from the commit dot to the bottom of the row). The vertical rail at the target column handles continuity in subsequent rows. The visual result is a curve that transitions into a straight rail -- exactly how GitKraken renders it.

---

## Scalability Considerations

| Concern | At 5 lanes | At 15 lanes | At 30+ lanes |
|---------|-----------|-------------|-------------|
| SVG width | 80px (5*16) | 240px | 480px+ -- may need horizontal scroll or lane compression |
| Edge count per row | ~7 (5 pass-through + 1-2 curves) | ~18 | ~35 -- still fine for SVG |
| Lane color cycling | 5 unique colors | Colors repeat (15 % 8 = 7 unique + repeats) | Noticeable repetition; consider 12+ colors for v0.3 |
| Visual clarity | Excellent | Good | Degraded -- consider lane packing optimization |

For typical repositories (< 10 simultaneous lanes), the architecture handles everything with no performance concerns. For monorepos with 30+ simultaneous branches, lane compression or horizontal scrolling would be needed -- defer this to a future milestone.

---

## Suggested Build Order

Dependencies flow upward; data changes must precede rendering changes.

### Step 1: Rust Data Changes (foundation)

1. Add `is_branch_tip: bool` to `GraphCommit` in `types.rs`
2. Add `GraphResponse` struct to `types.rs`
3. Modify `walk_commits()` to track `max_columns` and set `is_branch_tip`
4. Update `CommitCache` in `state.rs` to store `(Vec<GraphCommit>, usize)`
5. Update `get_commit_graph` in `history.rs` to return `GraphResponse`
6. Update existing tests in `graph.rs`

**Rationale:** All frontend work depends on having the data available. These are small, isolated changes with clear test coverage.

### Step 2: TypeScript Type Updates (bridge)

1. Add `GraphResponse` interface to `types.ts`
2. Add `is_branch_tip: boolean` to `GraphCommit` interface
3. Update `CommitGraph.svelte` to destructure `{ commits, max_columns }` from response
4. Thread `maxColumns` through `CommitRow.svelte` to `LaneSvg.svelte`

**Rationale:** Type changes are trivial but must happen before the LaneSvg rewrite can consume the new data.

### Step 3: LaneSvg Rewrite (the visual payoff)

1. Implement edge classification function
2. Render pass-through vertical rails (immediate visual impact -- "railroad tracks" appear)
3. Render first-parent continuation rails (commit dot connects to rail below)
4. Render incoming rail above commit dot (using `is_branch_tip` flag)
5. Render fork/merge bezier curves
6. Render commit dot (on top of everything)
7. Update lane width from 12px to 16px in LaneSvg and adjust CommitRow layout

**Rationale:** Building the rendering incrementally (rails first, then curves, then dot) allows visual verification at each step. Rails alone will make the graph look dramatically better; curves are refinement.

### Step 4: Polish (refinement)

1. Adjust WIP row SVG in `CommitGraph.svelte` to match new lane width
2. Verify visual continuity across pagination boundaries (load more commits, check rail alignment)
3. Test with complex topologies (many branches, octopus merges, long-lived feature branches)
4. Tune bezier control point factor (0.4) if curves feel too tight or too loose

**Rationale:** Polish depends on the core rendering being complete. Visual tuning is best done empirically.

---

## Sources

- **Existing codebase** -- `graph.rs`, `types.rs`, `LaneSvg.svelte`, `CommitRow.svelte`, `CommitGraph.svelte`, `state.rs`, `history.rs` -- all read directly. Confidence: HIGH.
- **[Commit Graph Drawing Algorithms (pvigier's blog)](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html)** -- Lane assignment algorithms, forbidden index computation, visible-node optimization via interval trees. Confidence: HIGH.
- **[Git Extensions Revision Graph wiki](https://github.com/gitextensions/gitextensions/wiki/Revision-Graph)** -- Per-row rendering strategy, segment-based lane tracking, lazy overlap calculation. Confidence: HIGH.
- **[DoltHub: Drawing a Commit Graph](https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/)** -- Cubic bezier control point formula for smooth curves, column assignment algorithm, CommitNode data structure. Confidence: HIGH.
- **vscode-git-graph source (graph.ts)** -- SVG path construction for smooth curves (`C x1,(y1+d) x2,(y2-d) x2,y2` where `d = grid.y * 0.8`), branch line consolidation, angular vs curved style rendering. Confidence: HIGH.
- **[react-commits-graph (generate-graph-data.coffee)](https://github.com/jsdf/react-commits-graph/blob/master/src/generate-graph-data.coffee)** -- Route-based pass-through lane tracking (`[from, to, branch]` tuples), reserve array for active lane management. Confidence: MEDIUM (archived project, but algorithm is sound).
- **[git2graph](https://github.com/alaingilbert/git2graph)** -- Per-row graph field structure `[column, row, color, edges]`, row-by-row rendering support for HTML tables. Confidence: MEDIUM.
- **[GitKraken commit graph feature page](https://www.gitkraken.com/features/commit-graph)** -- Visual reference for target quality; GitKraken uses near-straight lines rather than heavy curves. Confidence: MEDIUM (proprietary, no implementation details).
