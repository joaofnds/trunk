# Commit Graph Architecture

Deep reference for the commit graph system. Written from direct code reading and
debugging experience. Use this before touching any graph-related code.

---

## Overview: Two-Layer Pipeline

```
git repo
  │
  ▼
[Rust: graph.rs] walk_commits()
  │  Assigns columns, colors, edge types, dashed flags.
  │  Output: GraphCommit[] + max_columns
  │
  ▼
[TypeScript: active-lanes.ts] buildGraphData()
  │  Coalesces adjacent same-property Straight edges into OverlayEdge rails.
  │  Translates GraphCommit[] → OverlayNode[] + OverlayEdge[]
  │
  ▼
[TypeScript: overlay-paths.ts] buildOverlayPaths()
  │  Converts OverlayEdge[] → SVG path strings (M…V rails, cubic bezier connections).
  │
  ▼
[Svelte: CommitGraph.svelte]
   Renders SVG: dots, paths, pills.
```

Each layer is a pure transformation. **Never post-process the output of one layer
to compensate for something the prior layer should have done** — the layers are
interdependent and partial fixups create visual desync.

---

## Layer 1: Rust Backend (`src-tauri/src/git/graph.rs`)

### Entry point

```rust
pub fn walk_commits(repo: &mut git2::Repository, offset: usize, limit: usize)
    -> Result<GraphResult, TrunkError>
```

Returns `GraphResult { commits: Vec<GraphCommit>, max_columns: usize }`.

### Commit ordering

1. `revwalk` over `refs/heads`, `refs/remotes`, `refs/tags` with
   `TOPOLOGICAL | TIME` sort → `base_oids`.
2. Stash OIDs are collected separately via `repo.stash_foreach()`.
3. Each stash is **interleaved immediately before its parent** in the final `oids`
   list — so stashes appear topologically above their parent commit, just like any
   branch tip would.
4. Orphan stashes (parent not reachable from any ref) are prepended at the top.
5. A page slice `[offset..offset+limit]` is extracted for display, but the **lane
   algorithm runs over ALL oids** for correct lane continuity. Only `per_oid_data`
   for page commits is emitted.

### Core state (lane algorithm)

| Variable | Type | Purpose |
|---|---|---|
| `active_lanes` | `Vec<Option<Oid>>` | `active_lanes[col] = Some(oid)` means col is tracking oid's chain (waiting for that commit to be processed). `None` = lane is free. |
| `pending_parents` | `HashMap<Oid, usize>` | `pending_parents[oid] = col` means a child already reserved column `col` for `oid`. When `oid` is processed in Phase 1, it reads this to get its column. |
| `reserved_cols` | `HashSet<usize>` | Columns pre-reserved for stash parents. Prevents other commits from stealing these columns without creating ghost pass-through lines (we don't set `active_lanes` for reserved columns — the reservation is only in `pending_parents`). |
| `lane_colors` | `HashMap<usize, usize>` | Maps column → color index. Set when a branch first enters a column, removed when the branch terminates. |
| `stash_lanes` | `HashSet<usize>` | Columns currently belonging to a stash. Edges in these columns are marked `dashed: true`. |
| `next_color` | `usize` | Monotonically incrementing color counter. Color 0 is reserved for the HEAD chain. |

### HEAD chain pre-reservation (lines ~107-130)

Before processing any commit:
- Walk HEAD's first-parent chain into `head_chain: HashSet<Oid>`.
- Push `None` onto `active_lanes` → column 0 exists but is free.
- Set `lane_colors[0] = 0` (HEAD chain always color 0).
- Insert every head chain member into `pending_parents` pointing at column 0.

**Key implication**: `active_lanes[0]` is `None` throughout processing of stash
commits that come before any HEAD chain commit. The column is logically occupied
(reserved via `pending_parents`) but `active_lanes` doesn't reflect this until the
first HEAD chain commit is actually processed and sets `active_lanes[0] = Some(...)`.

### Per-commit processing (4 phases)

#### Phase 1: Column assignment (ACTIVATE)

```
if pending_parents.contains(oid)  → use that col (HEAD chain, merge parents, etc.)
else                              → new branch/stash, scan for free col
```

**Stashes use the exact same codepath as regular branch tips.** They get a free column,
a new color via `lane_colors`, and are marked in `stash_lanes` so their edges render
dashed. No special inline/branch-right logic — stashes are just branches with dashed visuals.

#### Phase 2: Pass-through and fork-in detection

Iterate `active_lanes`. For each `other_col != col`:
- If `active_lanes[other_col] == Some(oid)` → **fork-in**: a child kept this lane
  alive pointing to the current commit. Emit `ForkRight`/`ForkLeft` edge from `col`
  to `other_col`. Clean up: `active_lanes[other_col] = None`, `lane_colors.remove(other_col)`,
  `stash_lanes.remove(other_col)`.
- Otherwise → **pass-through**: emit `Straight` edge at `other_col` with that lane's
  color, `dashed` if `other_col ∈ stash_lanes`.

#### Phase 3: Terminate current slot

`active_lanes[col] = None` — the commit has been processed.

#### Phase 4: First-parent edge emission

For the first parent:
- If `pending_parents[parent_oid] == col` (same column, already reserved):
  - Emit Straight edge using `lane_colors[col]`, `dashed` if `stash_lanes.contains(col)`.
  - Set `active_lanes[col] = Some(parent_oid)`, `col_reoccupied = true`.
- If `pending_parents[parent_oid] != col` (different column):
  - Keep lane alive: `active_lanes[col] = Some(parent_oid)`, `col_reoccupied = true`.
  - Emit Straight edge at `col` (dashed if `stash_lanes.contains(col)`).
  - The parent, when later processed, detects this as a fork-in and emits ForkRight.
- If parent not in `pending_parents`:
  - **Orphan stash guard**: if `is_stash` and parent not in `base_oid_set`, lane ends
    here (don't keep alive — parent will never be processed).
  - Otherwise: claim it: `active_lanes[col] = Some(parent_oid)`, `pending_parents[parent_oid] = col`.

**Stash-specific**: stashes only have one logical parent (index `0`). Parents 1+ are
internal git stash bookkeeping (index tree, untracked tree) and are ignored.

### `GraphCommit` output fields

| Field | Meaning |
|---|---|
| `column` | Swimlane index (0 = leftmost) |
| `color_index` | Color for the dot and its ref pill. Always `lane_colors[col]`. |
| `edges` | All edges visible at this commit's row (pass-throughs, fork-in/out, straight continuation) |
| `is_branch_tip` | `active_lanes[col]` was `None` when this commit was assigned its column |
| `is_stash` | From stash OID set |
| `is_merge` | `parent_count >= 2` AND NOT stash |
| `is_head` | One of its refs has `is_head: true` |
| `parent_oids` | For stashes: only first parent (base commit). For others: all parents. |

### Edge types

| Type | Meaning |
|---|---|
| `Straight` | `from_col == to_col`: lane continues vertically |
| `ForkRight` | Lane branches right (child at `from_col`, fork target at `to_col > from_col`) |
| `ForkLeft` | Lane branches left |
| `MergeRight` | Merge from the right |
| `MergeLeft` | Merge from the left |

`dashed: true` on an edge means it belongs to a stash segment.

---

## Layer 2: TypeScript — `active-lanes.ts`

### `buildGraphData(commits, maxColumns): OverlayGraphData`

Transforms `GraphCommit[]` into the overlay coordinate system.

**Coordinate system**:
- `x` = swimlane (column) index
- `y` = row index (0 = top)

**WIP sentinel** (`commit.oid === '__wip__'`): handled specially.
- Emits a node at `(commit.column, y)`.
- Finds the anchor row by scanning downward for the first `in_head_chain` commit —
  the topmost displayed commit of HEAD's first-parent chain. Unlike `is_head`
  (only set when HEAD resolves to a local branch), this exists during detached
  HEAD too (e.g. mid-rebase, where it anchors on the `onto` target).
- If no head-chain row is loaded (unborn HEAD, or pagination hasn't reached the
  chain yet), no WIP connection is emitted — no anchor, no line.
- Emits dashed straight edges from WIP down to the anchor, **split around inline
  stash rows** so the dashed line doesn't visually pass through hollow stash squares.

**Edge coalescing** (the core of this layer):
- Maintains `activeLanes: Map<column, { startY, colorIndex, dashed }>`.
- For each commit row, processes its `edges[]`:
  - Straight edges (`from_col == to_col`): coalesced. If an active lane exists at
    that column with identical `colorIndex` and `dashed`, extend it (no-op). Otherwise
    flush the old lane as an `OverlayEdge` and start a new one.
  - Non-straight edges (connections): emitted immediately as single-row `OverlayEdge`.
- At end of each row: flush any active lanes not continued by a Straight edge.
- **Why this matters**: adjacent rows with identical Straight edges become a single
  long `OverlayEdge` spanning many rows, greatly reducing SVG path count. The
  `dashed` flag is part of the coalesce key — a dashed→non-dashed transition always
  creates a break (stash rail above, regular rail below).

**`OverlayEdge`** (same-lane): `fromX == toX`, spans `fromY..toY`.
**`OverlayEdge`** (connection): `fromX != toX`, single row (`fromY == toY`).

---

## Layer 3: TypeScript — `overlay-paths.ts`

### `buildOverlayPaths(data, settings): OverlayPath[]`

Pure function. Converts each `OverlayEdge` to an SVG path string.

**Coordinate helpers** (from `GraphDisplaySettings`):
```
cx(col) = col * laneWidth + laneWidth / 2   // column center x
cy(row) = row * rowHeight + rowHeight / 2   // row center y
rowTop(row) = row * rowHeight
rowBottom(row) = (row + 1) * rowHeight
R = laneWidth / 2                           // bezier corner radius
```

### Rail paths (same-lane, `fromX == toX`)

`M cx(col) startY V endY`

Endpoint awareness:
- **Start (fromY has a node)**:
  - Branch tip + hollow (stash/WIP/merge): start at `cy(fromY) + dotRadius + DASH_GAP` (below hollow dot edge)
  - Branch tip + filled: start at `cy(fromY)` (dot center)
  - No tip: start at `rowTop(fromY)` (full row top)
- **End (toY)**:
  - Branch tip + hollow: end at `cy(toY) - dotRadius - DASH_GAP` (above hollow dot edge)
  - Branch tip + filled: end at `cy(toY)` (dot center)
  - No node: end at `cy(toY) - R` (leave room for bezier corner)
  - Non-tip node: end at `rowBottom(toY)` (continue through row)

### `isHollow(node)`: stash, WIP, merge → hollow (rect or ring, not filled dot)

### Connection paths (cross-lane, `fromX != toX`)

Manhattan routing with a single cubic bezier 90° rounded corner:
```
M cx(fromX) cy(fromY)          ← start at source column center
H hTarget                       ← horizontal to R before corner
C cp1x cp1y cp2x cp2y cornerX cornerY  ← bezier quarter-circle
```
No vertical tail — the rail in the target column provides vertical continuity.

**Corner direction** determined by `isMergePattern()`:
- If a rail in `toX` **starts** at `fromY` → merge (curves down, `vSign = +1`)
- If a rail in `toX` **ends** at `fromY` → fork (curves up, `vSign = -1`)

---

## Layer 4: Svelte — `CommitGraph.svelte`

Renders:
- **Dots**: filled circles for normal commits; hollow dashed rects for stashes;
  hollow rings for merges; WIP "dot" is a dashed rect at column 0 row 0.
- **Paths**: SVG `<path>` elements from `buildOverlayPaths()`, colored by
  `laneColor(colorIndex)`, dashed via `stroke-dasharray`.
- **Pills**: ref labels from `OverlayRefPill[]`.

---

## Stash Specifics

### Git stash internals

A git stash creates a commit with **2–3 parents**:
1. `parent[0]` = the base commit (HEAD at stash time) ← the only one used by the graph
2. `parent[1]` = index tree state
3. `parent[2]` = untracked files (optional)

The graph intentionally ignores parents 1+ — they are internal bookkeeping, not
part of the history DAG.

### Stash rendering

A stash is treated as a **regular branch tip** with dashed visuals. No special column
assignment, no inline placement — it flows through the exact same algorithm as any
other commit that's not in `pending_parents`.

```
    ┊ □        ← stash at own col, dashed hollow rect
    ┊╱         ← dashed ForkRight connection
────●──        ← parent col=0, ForkRight edge → stash col
    │
```

Algorithm:
1. Stash gets a free column via the standard branch-tip scan (same as any new branch).
2. `stash_lanes.insert(stash_col)` → all edges at that col are marked `dashed: true`.
3. Stash Phase 4: `active_lanes[stash_col] = Some(parent_oid)`, `pending_parents[parent_oid] = stash_col`, emit dashed Straight.
   - **Orphan stash guard**: if parent not in `base_oid_set`, lane ends here (no Straight, no `pending_parents` claim).
4. Parent Phase 2: detects fork-in at `stash_col`, emits dashed `ForkRight`.
5. Parent Phase 2 cleanup: `active_lanes[stash_col] = None`, `lane_colors.remove`, `stash_lanes.remove`.

---

## Coupling Hazards

The lane algorithm has deeply coupled state. Changing any one thing cascades:

| If you change... | ...it affects |
|---|---|
| `stash_lanes` | Every pass-through edge at that column gets dashed |
| `pending_parents` removal timing | Fork-in detection in Phase 2 depends on `active_lanes` holding the child's oid until the parent is processed |
| `active_lanes` layout | `max_columns` high-water mark, `is_branch_tip` detection, fork-in scan all use this |

**Design principle**: stashes use the same algorithm as regular branches. The ONLY
stash-specific code is: (1) parent filtering (only first parent), (2) `stash_lanes`
marking for dashed visuals, (3) orphan stash guard in Phase 4, (4) `is_stash` flag
on output.

**Rule**: Never post-process graph output. If the visual output is wrong, fix the
algorithm that produces it.

---

## Testing

```bash
# Rust unit tests (fast, in-process test repos)
cd src-tauri && cargo test --lib

# TypeScript unit tests
npx vitest run

# Visual
cargo tauri dev    # then open a repo with stashes
```

Key test cases to maintain:
- `stash_branches_right_like_regular_branch` — stash at own col, own color, dashed edges, ForkRight on parent
- `multiple_stashes_on_same_parent` — both stashes branch right at own columns, 2 ForkRight on parent
- `stash_branches_right_when_head_chain_occupies_lane` — mid-chain stash branches right, ForkRight on parent
- `stash_branches_right_with_topic_branch` — stash on HEAD branches right even with other branches present
- Orphan stash — standalone dot, no connector, no ghost lane
- WIP + stash coexist — dashed WIP line splits around inline stash nodes

---

## File Map

| File | Role |
|---|---|
| `src-tauri/src/git/graph.rs` | Rust lane algorithm, all column/color/edge computation |
| `src-tauri/src/git/types.rs` | Rust types: `GraphCommit`, `GraphEdge`, `EdgeType` |
| `src/lib/types.ts` | TS mirror types + overlay types (`OverlayNode`, `OverlayEdge`, `OverlayPath`) |
| `src/lib/active-lanes.ts` | `buildGraphData()` — edge coalescing, WIP sentinel |
| `src/lib/overlay-paths.ts` | `buildOverlayPaths()` — SVG path generation |
| `src/lib/graph-constants.ts` | `DEFAULT_GRAPH_SETTINGS` (rowHeight, laneWidth, dotRadius, etc.) |
| `src/components/CommitGraph.svelte` | SVG rendering, dot shapes, pill rendering |
