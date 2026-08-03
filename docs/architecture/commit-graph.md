# Commit Graph Architecture

Deep reference for the commit graph system. Written from direct code reading and
debugging experience. Read before changing lane assignment, edge emission, or node
rendering.

---

The binding constraints on this pipeline live in `.claude/rules/commit-graph.md`. This
document explains how the algorithm works, and it paraphrases some of those constraints to
do so — the marker shapes, the `can_inline` clauses, the accepted dirtiness churn. Where the
two disagree the rule file wins, and a passage here is never a "stale doc" to bring in line
with code that broke a rule.

## Overview: The Pipeline

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
  │  Translates GraphCommit[] → OverlayNode[] + OverlayConnection[],
  │  one connection per loaded parent. No lane state, no coalescing.
  │
  ▼
[TypeScript: overlay-paths.ts] buildOverlayPaths()
  │  Converts each OverlayConnection → one SVG path string
  │  (M…V vertical, or a cubic bezier 90° corner for cross-column).
  │
  ▼
[TypeScript: overlay-visible.ts] getVisibleOverlayElements()
  │  Drops paths, dots and pills outside the scrolled viewport.
  │
  ▼
[Svelte: CommitGraph.svelte]
   Renders SVG: dots, paths, pills.
```

Each stage is a pure transformation. What you may and may not do across stage boundaries is
a binding rule, stated once in `.claude/rules/commit-graph.md`.

---

## Layer 1: Rust Backend (`src-tauri/src/git/graph.rs`)

### Entry point

```rust
pub fn walk_commits(repo: &mut git2::Repository, offset: usize, limit: usize)
    -> Result<GraphResult, TrunkError>
```

Returns `GraphResult { commits: Vec<GraphCommit>, max_columns: usize }`.

### Commit ordering

1. Stash OIDs are collected via `repo.stash_foreach()`. A stash joins the walk only if it
   and every one of its parents read back from the object store (`graph.rs:73-94`); an
   unreadable one is skipped, so a corrupt object costs that stash its row instead of
   failing the walk for the whole repo.
2. `revwalk` over `refs/heads`, `refs/remotes`, `refs/tags` **plus every walkable stash
   OID**, with `TOPOLOGICAL | TIME` sort (`graph.rs:96-107`). Git orders the stashes with
   everything else: `TOPOLOGICAL` puts a commit above its parents unconditionally, and
   `TIME` only breaks ties between topologically independent commits. So a stash sorts
   above its parent whatever its committer time says, and a stash whose first parent is
   another stash falls out of the same rule. There is no separate ordering step for
   stashes and no `base_oids` list.
3. Pushing a stash makes its parents 1.. reachable — the index tree, and the untracked
   tree under `INCLUDE_UNTRACKED`. They are dropped from the collected list, or they would
   appear as rows of their own.
4. Because a stash's parent is always in the walk, a stash keeps its connector even when
   `reset --hard` has dropped that parent from every ref. Dropping the stash is what
   removes such a commit from the graph.
5. A page slice `[offset..offset+limit]` is extracted for display, but the **lane
   algorithm runs over ALL oids** for correct lane continuity. Only `per_oid_data`
   for page commits is emitted.

### Core state (lane algorithm)

| Variable | Type | Purpose |
|---|---|---|
| `active_lanes` | `Vec<LaneSlot>` | `active_lanes[col] = Some((oid, dashed))` means col is tracking oid's chain (waiting for that commit to be processed). `None` = lane is free. |
| `pending_parents` | `HashMap<Oid, usize>` | `pending_parents[oid] = col` means a child already reserved column `col` for `oid`. When `oid` is processed in Phase 1, it reads this to get its column. |
| `lane_colors` | `HashMap<usize, usize>` | Maps column → color index. Set when a branch first enters a column, removed when the branch terminates. |
| `next_color` | `usize` | Monotonically incrementing color counter. Color 0 is reserved for the HEAD chain. |

`active_lanes` is a `Vec<LaneSlot>` where `LaneSlot = Option<(Oid, bool)>` (`graph.rs:18`).
The `bool` is the dashed flag, set by whichever commit takes the lane — `true` for a stash,
`false` otherwise. There is no separate `stash_lanes` or `reserved_cols` set; `4a9f15e`
removed the last of them in favour of carrying the flag on the lane.

### HEAD chain pre-reservation (`graph.rs:131-156`)

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

**Stashes mostly share the branch-tip codepath, with one placement exception.**
`can_inline` (`graph.rs:183-188`) puts a stash *inline* — at its parent's own column,
consuming no new lane and no new colour — when all of these hold:

1. it is a stash;
2. **the worktree is clean** (`!worktree_dirty`, read once per walk via
   `git::status::worktree_dirty`);
3. its first parent already has a column reserved;
4. that parent is the HEAD tip, or is outside the HEAD chain;
5. the parent's column is unoccupied in `active_lanes`.

Otherwise it takes a free column and a new colour like any branch tip.

Clause 4's second half looks like it would inline a stash away from column 0, and it does
not. Clauses 3 and 5 together demand a column that is reserved in `pending_parents` but
still free in `active_lanes`, and every other site sets those two together — only the
HEAD-chain pre-reservation (`graph.rs`, "Pre-reserve column 0") leaves a column in that
state. So every inline lands at column 0, and clause 4 narrows it further to the HEAD tip.
A stash whose parent sits on a topic branch off the HEAD chain branches right instead,
taking its own lane and colour (probed 2026-08-03).

Clause 2 exists because the frontend draws its WIP row in the HEAD column whenever the
worktree is dirty (`CommitGraph.svelte`, `displayItems`), and an inline stash lands in that
same column — so without it the stash square sits on the WIP line. The cost is
accepted churn: because the inline path consumes neither lane nor colour and stashes are
placed before branch tips, toggling clean↔dirty can shift an unrelated branch's colour, and
its column too when that branch sorts between the stash and the stash's parent. Both shapes
are pinned in `src-tauri/tests/test_graph.rs` (`dirtiness_relayouts_unrelated_branches`,
`dirtiness_recolors_branches_below_the_stash_parent`).

#### Phase 2: Pass-through and fork-in detection

Iterate `active_lanes`. For each `other_col != col`:
- If `active_lanes[other_col] == Some(oid)` → **fork-in**: a child kept this lane
  alive pointing to the current commit. Emit `ForkRight`/`ForkLeft` edge from `col`
  to `other_col`. Clean up: `active_lanes[other_col] = None`, `lane_colors.remove(other_col)`.
- Otherwise → **pass-through**: emit `Straight` edge at `other_col` with that lane's
  color, `dashed` from that lane slot's flag.

#### Phase 3: Terminate current slot

`active_lanes[col] = None` — the commit has been processed.

#### Phase 4: First-parent edge emission

For the first parent:
- If `pending_parents[parent_oid] == col` (same column, already reserved):
  - Emit Straight edge using `lane_colors[col]`, `dashed` from the lane slot's flag.
  - Set `active_lanes[col] = Some(parent_oid)`, `col_reoccupied = true`.
- If `pending_parents[parent_oid] != col` (different column):
  - Keep lane alive: `active_lanes[col] = Some(parent_oid)`, `col_reoccupied = true`.
  - Emit Straight edge at `col` (dashed from the lane slot's flag).
  - The parent, when later processed, detects this as a fork-in and emits ForkRight.
- If parent not in `pending_parents`:
  - Claim it: `active_lanes[col] = Some(parent_oid)`, `pending_parents[parent_oid] = col`.
    This applies to stashes too — pushing them into the revwalk means a stash's parent is
    always in the walk, so there is no orphan case to special-case.

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

**Per-parent connections** (every non-WIP row):
- One `OverlayConnection` per entry in `parent_oids`, child → parent.
- A parent that is not on the loaded page is skipped, so the line just stops at the
  pagination boundary rather than running off the end.
- Colour selection:
  - Same column: the colour of the Straight edge in the child's own column, falling
    back to the child's `color_index`.
  - Cross-column merge: the **parent's** colour — the branch being merged in.
  - Cross-column fork: the **child's** colour — the new branch.
- `dashed` is `commit.is_stash`.

**There is no lane state and no coalescing.** Each connection spans exactly one
child→parent pair, however many rows apart they sit, and Layer 3 emits one path for
each. `commit.edges[]` is read for one purpose only: the same-column colour lookup
above. Nothing consumes the Rust `EdgeType` variants on this side.

**`OverlayConnection`** (`types.ts`): `childX/childY` → `parentX/parentY`, plus
`colorIndex` and `dashed`. Same column and cross-column use the same record; Layer 3
branches on the coordinates.

---

## Layer 3: TypeScript — `overlay-paths.ts`

### `buildOverlayPaths(data, settings): OverlayPath[]`

Pure function. Emits exactly one `OverlayPath` per `OverlayConnection`, in order.

**Coordinate helpers** (from `GraphDisplaySettings`):
```
cx(col) = col * laneWidth + laneWidth / 2   // column center x
cy(row) = row * rowHeight + rowHeight / 2   // row center y
R = laneWidth / 2                           // bezier corner radius
KAPPA = 4(√2−1)/3                           // quarter-circle control offset
DASH_GAP = 3                                // matches stroke-dasharray "3 3"
```

`isHollowTip(node)` is `(isBranchTip || isWip) && (isStash || isWip || isMerge)`.
A hollow tip pulls the path end back by `dotRadius + DASH_GAP` so the stroke stops at
the ring's edge instead of crossing it.

### Direction of travel

`rowSign = Math.sign(parentY - childY)` is `+1` when the parent sits below the child and
`-1` when it sits above. Every vertical offset is multiplied by it — the endpoint pull-in,
the corner, and the bezier control points. The magnitudes (`R`, `dotRadius`, `DASH_GAP`,
`KAPPA`) never change; only their sign is derived.

Layer 1 orders a stash by the revwalk, so it cannot emit a parent above its child. The sign
covers the transient case: pagination, and any future ordering change. Do not delete it as
dead code without reverting that ordering too.

### Which of three shapes

Decided per connection, in this order:

1. **`childX === parentX` — vertical.** `M cx(col) startY V endY`.
2. **`childNode.isMerge` — horizontal, corner, vertical.**
   `M startX startY H hTarget C … cornerX cornerY V endY`. The corner lands in the
   parent's column, `R` from the child's row toward the parent.
3. **Otherwise (fork) — vertical, corner, horizontal.**
   `M cornerX startY V vTarget C … hStart cornerY H endX`. The corner lands in the
   child's column, at the parent's row.

Shapes 2 and 3 both keep a tail past the curve. The choice is the child node's
`isMerge` flag, not an inspection of what else occupies the target column.

Nothing guards segment length or row order. An equal-row connection emits a degenerate
path, which is safe because a commit cannot be its own parent. A guard here was removed in
milestone 2 of the backdated-stash work: it returned an empty `d` and left the row interval
inverted, so it hid one defect behind another.

That removal puts a floor under `rowHeight`. Below **18**, two hollow tips one row apart
pull their ends past each other and the segment inverts — measured at `rowHeight 17`, 252 of
11200 downward cases. `rowHeight` is a measured float from `VirtualList`, and neither
sub-pixel snapping nor browser zoom takes it near 18; only a smaller
`DEFAULT_GRAPH_SETTINGS.rowHeight` would. Constrain it where `svgSettings` is assembled in
`CommitGraph.svelte`, not at a settings page.

Every path also carries `minRow`/`maxRow`: the two rows in ascending order, never child
then parent. `overlay-visible.ts` culls on that interval, and an inverted pair drops a
partially-visible connector instead of clipping it.

---

## Layer 4: Svelte — `CommitGraph.svelte`

Renders:
- **Dots** (`overlay-dots`, one branch per kind): dashed hollow circle for WIP; dashed
  hollow `<rect>` for a stash; solid-stroke hollow circle for a merge; filled circle
  otherwise. WIP sits at row 0 in the head-chain column, which is 0 in practice.
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

The marker shape is fixed by rule (`.claude/rules/commit-graph.md`). Its **placement** takes
one of two shapes, decided by `can_inline` (see Phase 1 above) — the deciding input is
worktree dirtiness.

Branch-right (dirty worktree, or any other `can_inline` clause failing):

```
    ┊ □        ← stash at own col, dashed hollow rect
    ┊╱         ← dashed ForkRight connection
────●──        ← parent col=0, ForkRight edge → stash col
    │
```

1. Stash gets a free column via the standard branch-tip scan and a new colour.
2. The lane's dashed flag is set to `true`, so edges at that col render dashed.
3. Stash Phase 4: `active_lanes[stash_col] = Some((parent_oid, true))`, `pending_parents[parent_oid] = stash_col`, emit dashed Straight.
4. Parent Phase 2: detects fork-in at `stash_col`, emits dashed `ForkRight`.
5. Parent Phase 2 cleanup: `active_lanes[stash_col] = None`, `lane_colors.remove`.

Inline (clean worktree, parent is the HEAD tip and its column is free):

```
    □          ← stash in the parent's own column, dashed hollow rect
    ┊          ← dashed Straight, no fork
────●──        ← parent, no ForkRight
    │
```

The stash takes the parent's column verbatim and inherits its colour, consuming no new
lane and no new colour. `max_columns` is unchanged.

---

## Coupling Hazards

The lane algorithm has deeply coupled state. Changing any one thing cascades:

| If you change... | ...it affects |
|---|---|
| A lane's dashed flag | Every pass-through edge at that column gets dashed |
| `pending_parents` removal timing | Fork-in detection in Phase 2 depends on `active_lanes` holding the child's oid until the parent is processed |
| `active_lanes` layout | `max_columns` high-water mark, `is_branch_tip` detection, fork-in scan all use this |
| The dirtiness read | Stash placement, and through it the column and colour of unrelated branches — see `can_inline` in Phase 1 |

**Where the stash-specific code is**: (1) parent filtering (only first parent), (2) the
lane's dashed flag, (3) `is_stash` flag on output, (4) the `can_inline` placement exception,
(5) the readability pre-flight that keeps an unreadable stash out of the revwalk. What each is *allowed* to do — the rendering
shape, the dirtiness dependency, the post-processing prohibition — is stated once, in
`.claude/rules/commit-graph.md`.

---

## Testing

Test commands are in `.claude/rules/commit-graph.md`.

For visual checks, `just dev` and open a repo with stashes.
`scripts/qa-stash-fixtures.sh` builds a set of repos covering inline placement, each flavour
of dirtiness, the multi-stash, orphan, detached-HEAD, merge-tip and bare cases, and both
accepted-churn shapes, with a per-scenario checklist.

Key test cases to maintain (all in `src-tauri/tests/test_graph.rs`):
- `stash_inline_on_head_tip` — clean tree, stash on the HEAD tip: parent's column, parent's colour, dashed Straight, no ForkRight
- `stash_inline_with_topic_branch` — inline still holds with another branch present
- `stash_stays_inline_when_worktree_clean` / `stash_branches_right_when_worktree_dirty` — the paired control for the dirtiness clause
- `stash_branches_right_when_only_untracked` / `..._only_staged` — pins `include_untracked(true)` and the `INDEX_*` bits
- `multiple_stashes_on_same_parent` — the newest inlines, the older branches right
- `stash_branches_right_when_head_chain_occupies_lane` — mid-chain stash branches right, ForkRight on parent
- `dirtiness_relayouts_unrelated_branches` / `dirtiness_recolors_branches_below_the_stash_parent` — the accepted churn
- `graph_and_dirty_counts_agree_when_*` — the graph and `get_dirty_counts` never disagree about dirtiness
- `walk_commits_on_bare_repo_does_not_error` — `statuses()` refuses bare repos; the walk must survive it
- `orphan_stash_shows_its_parent` — a parent dropped from every ref still gets a row, and the dashed connector lands on it
- `first_parent_never_sorts_above_its_child` / `no_oid_appears_twice` — over every stash shape whose ordering committer time could invert
- `unreadable_stash_commit_is_skipped` / `unreadable_stash_index_commit_is_skipped` — one bad object costs one stash, not the graph
- WIP + stash coexist — dashed WIP line splits around inline stash nodes

---

## File Map

| File | Role |
|---|---|
| `src-tauri/src/git/graph.rs` | Rust lane algorithm, all column/color/edge computation |
| `src-tauri/src/git/status.rs` | The one definition of worktree dirtiness, shared with the dirty counters |
| `src-tauri/src/git/types.rs` | Rust types: `GraphCommit`, `GraphEdge`, `EdgeType` |
| `src/lib/types.ts` | TS mirror types + overlay types (`OverlayNode`, `OverlayConnection`, `OverlayPath`) |
| `src/lib/active-lanes.ts` | `buildGraphData()` — per-parent connections, WIP sentinel |
| `src/lib/overlay-paths.ts` | `buildOverlayPaths()` — SVG path generation |
| `src/lib/overlay-visible.ts` | Viewport culling of paths, dots and pills before render |
| `src/lib/graph-constants.ts` | `DEFAULT_GRAPH_SETTINGS` (rowHeight, laneWidth, dotRadius, etc.) |
| `src/components/CommitGraph.svelte` | SVG rendering, dot shapes, pill rendering |
| `src-tauri/tests/test_graph.rs` | Owns the graph layout assertions; pins the accepted dirtiness churn |

This table and the `paths:` list in `.claude/rules/commit-graph.md` are the same set — keep
them in step, or the rule stops firing for a file it governs.
