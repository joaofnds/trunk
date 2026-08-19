# Gitamine Algorithm Study

Reference analysis of the "straight branches" commit graph algorithm from
[pvigier's blog post](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html)
and [gitamine](https://github.com/pvigier/gitamine) implementation. Compared
against Trunk's current `placement.rs` algorithm to identify structural differences
and improvement opportunities.

---

## The Two Decisions in Graph Drawing

Drawing a commit graph on a 2D grid requires two decisions per commit:
1. **Row (i)**: Which row? → Solved by sorting (topological + temporal)
2. **Column (j)**: Which column? → Solved by the lane/placement algorithm

These are independent. Gitamine solves them in two separate phases.
Trunk conflates them somewhat: the same revwalk that decides rows also decides the order
in which the lane algorithm sees commits, and that decides columns.

---

## Part 1: Sorting — "Temporal Topological Sort"

### The Problem

Commits must be ordered so all edges point the same direction (parents below
children). This is a topological ordering. But there are many valid topological
orderings — we want one that also respects dates (recent commits at top).

### Gitamine's Solution (repo-wrapper.ts:264-290)

```
procedure temporal_topological_sort(C):
    1. Sort C by date (newest first)
    2. For each commit c in date order:
           DFS into c's children first
           Then assign c.i = next_index++
```

Properties:
- **Always topological** — DFS ensures children come before parents
- **Deterministic** — date-sorting gives consistent input order
- **Date-respecting** — if dates already form a valid topological order, the
  output matches the date order exactly
- **O(n log n + m)** — sort + DFS

### Trunk's Equivalent

> **The divergence described below was closed on 2026-08-03.** Trunk pushes stash OIDs
> into the revwalk itself, so it now does exactly what this section recommends. The
> comparison is kept as the record of why.

Trunk uses `git2::Revwalk` with `TOPOLOGICAL | TIME` sort flags, which does
essentially the same thing. The key difference *was*: Trunk then **interleaved
stashes before their parent** in a post-processing step, which the sort
doesn't account for. Gitamine doesn't do this — stashes land wherever the
topological sort places them (which is always before their parent, since
children precede parents in topological order).

### Takeaway

No fundamental sorting difference. Both produce valid topological orders.
Trunk's stash interleaving is unnecessary if the sort already places stashes
before their parents (which topological order guarantees). Acted on: the
interleave is gone, and the stashes ride the walk.

---

## Part 2: Column Placement — "Straight Branches" Algorithm

This is the core algorithm. It determines each commit's column so that
first-parent chains form straight vertical lines.

### Key Definitions

- **Branch child** of commit c: a child whose first parent IS c
  (`child.parents[0] === c`). This child continues or creates a branch at c.
- **Merge child** of commit c: a child whose first parent is NOT c
  (`child.parents[0] !== c`). This child merged c in from a different branch.

This distinction is critical. Branch children inherit columns (straight lines).
Merge children create cross-column edges (curved connections).

### Data Structures (gitamine: commit-graph.ts)

| Structure | Type | Purpose |
|-----------|------|---------|
| `branches` | `(string \| null)[]` | Active branches. `branches[col] = sha` means col is occupied. `null` = free. Equivalent to Trunk's `active_lanes`. |
| `activeNodes` | `Map<sha, Set<col>>` | For each commit, tracks which columns are occupied between it and its last parent. Used to compute forbidden indices. **No Trunk equivalent.** |
| `activeNodesQueue` | `PriorityQueue` | Efficiently removes stale `activeNodes` entries. |

**Notably absent** (vs Trunk):
- No `pending_parents` — column inheritance is implicit via "replace"
- No `lane_colors` — color = `column_index % NUM_COLORS` (deterministic)
- No `stash_lanes` — stashes are just commits with different NodeType (Trunk has had none
  since `4a9f15e` either)
- No `head_chain` pre-reservation — HEAD just replaces 'index' at col 0
- No `reserved_cols` — not needed without pending_parents

### The Algorithm (commit-graph.ts:54-162)

```
procedure straight_branches(C):
    branches = ['index']   // column 0 reserved for working tree
    
    for each commit c in topological order:
        // 1. CLASSIFY CHILDREN
        branchChildren = {child : child.parents[0] === c}
        mergeChildren  = {child : child.parents[0] !== c}
        
        // 2. COMPUTE FORBIDDEN INDICES
        //    Find columns occupied between current row and highest merge child.
        //    Placing c at a forbidden column would make a merge edge cross
        //    an occupied column.
        highestMergeChild = min(mergeChild.i for mergeChild in mergeChildren)
        forbiddenIndices = activeNodes.get(highestMergeChild) ?? {}
        
        // 3. FIND COLUMN
        if c is HEAD:
            replace 'index' at column 0
        else if any branchChild has a non-forbidden column:
            replace the LEFTMOST such branchChild  // ← KEY: straight branches
        else if c has any children:
            insertCommit(c, near firstChild.column, forbiddenIndices)
        else:
            insertCommit(c, near column 0, {})
        
        // 4. UPDATE ACTIVE NODES
        //    Record which columns are now occupied (for future forbidden checks)
        for each existing activeNode entry:
            add c.column and all branchChildren columns to its set
        create new activeNode entry for c (lives until c's last parent)
        
        // 5. REMOVE UNUSED BRANCH CHILDREN
        //    Children that were NOT chosen for replacement → free their columns
        for child in branchChildren where child != chosenChild:
            branches[child.column] = null
        
        // 6. SET POSITION
        positions[c] = (i, j, type)
```

### The "Replace" Mechanism (THE key concept)

This is what makes branches straight. When processing a parent:
1. Look at branch children (already processed, have positions)
2. Pick one and **take its column**
3. Result: parent and child share the same column → vertical line

```
Processing order: child first, then parent
  
  child processed → gets column X
  parent processed → replaces child at column X
  
  Visual result:
  col X
    ●  ← child
    │
    ●  ← parent (same column = straight line)
```

**This is fundamentally different from Trunk's approach.** In Trunk:
- Child reserves a column for parent via `pending_parents`
- Parent reads from `pending_parents` to get its column
- The "reservation" direction is the same, but the mechanism differs

### insertCommit — Proximity-Based Free Column Search

```typescript
function insertCommit(sha, target_j, forbiddenIndices):
    // Try columns ±1, ±2, ±3... from target
    for dj = 1, 2, 3...:
        if target_j + dj is free and not forbidden: use it
        if target_j - dj is free and not forbidden: use it
    // Last resort: append new column
    branches.push(sha)
```

This **spiral outward** search ensures new branches are placed NEAR their
related commits, not at the first globally-available slot. This is why
gitamine's graphs are more compact than Trunk's.

**Trunk's equivalent**: linear scan from column 1 (or 0), incrementing until
finding a free slot. This pushes unrelated branches (like stashes) far to the
right when many columns are occupied.

### Forbidden Indices — Preventing Edge Crossings

For merge children, gitamine tracks which columns are occupied between the
merge child's row and the current commit's row. If the commit were placed
at one of these columns, the merge edge would cross an occupied lane.

```
  col 0  col 1  col 2  col 3
    ●                           ← merge child (row 5, col 0)
    │      ●                    ← some commit at col 1 (row 6)
    │      │      ●             ← some commit at col 2 (row 7)
    │      │      │      ?      ← current commit (row 8)
    
  If current goes at col 0: merge edge is straight (OK)
  If current goes at col 1: merge edge crosses col 1 lane (BAD → forbidden)
  If current goes at col 2: merge edge crosses cols 1+2 (BAD → forbidden)
  If current goes at col 3: merge edge goes right, no crossing (OK)
```

Trunk has **no equivalent**. Merge edges can cross occupied lanes.

---

## Part 3: Edge Building — Post-Processing vs Inline

### Gitamine: Edges as Post-Processing (commit-graph.ts:164-173)

After ALL positions are computed, edges are built trivially:

```typescript
for each (commitSha, [i0, j0]) in positions:
    for each (index, parentSha) in commit.parents:
        [i1, j1] = positions.get(parentSha)
        type = index > 0 ? EdgeType.Merge : EdgeType.Normal
        edges.insert(i0, i1, [[i0, j0], [i1, j1], type])
```

Edges are stored in an interval tree for efficient visibility queries during
rendering. Each edge is simply: start position, end position, type.

### Trunk: Edges Inline During Layout (placement.rs phases 2+4)

Trunk emits edges AS it computes columns. Each commit row generates:
- Pass-through edges for all active lanes
- Fork-in/fork-out edges for lane convergence
- Straight/merge edges for parent connections

This means **changing column assignment changes edge emission**, creating
tight coupling. In gitamine, column assignment and edge building are
independent — you can change one without affecting the other.

### Edge Rendering Comparison

| Aspect | Gitamine | Trunk |
|--------|----------|-------|
| When built | After all positions computed | During column assignment |
| Edge data | `[[i0,j0], [i1,j1], type]` | `GraphEdge { from_col, to_col, edge_type, color, dashed }` |
| Storage | Interval tree | Per-row Vec in GraphCommit |
| Types | Normal, Merge | Straight, ForkLeft/Right, MergeLeft/Right |
| Rendering | Direct line/curve from start to end | Rail segments + bezier connections |

### Edge Drawing (graph-canvas.tsx:128-165)

Gitamine draws edges as simple lines with one curve at the bend point:

- **Same column**: straight line from node to node
- **Different columns, Normal (branch)**: vertical down from child, then
  curve to parent's column (child's color)
- **Different columns, Merge**: horizontal from parent, then curve down to
  merge parent's column (parent's color)

```
Normal edge (branch):     Merge edge:
    ●  col 0                  ●  col 0
    │                         ├──────╮
    │                         │      │
    ╰──●  col 1               │      ●  col 1
       │
```

Trunk's rendering is more sophisticated (separate rails + bezier connections)
but also more complex to maintain.

---

## Part 4: Stash Handling — The Critical Comparison

> **STALE as of 2026-08-02.** This part describes Trunk's pre-`b5c1222` stash algorithm.
> Trunk no longer always branches stashes right: `can_inline` (`placement.rs:263-270`) places a
> stash at its parent's own column, inheriting its colour, when the worktree is clean and the
> parent is the HEAD tip. It also no longer tracks `stash_lanes` — the dashed flag rides on
> the lane slot (`placement.rs:18`). For current behaviour see
> `docs/architecture/commit-graph.md` § "Stash rendering". The gitamine comparison
> itself is unaffected.

### Gitamine: Zero Special Logic

The ENTIRE stash-specific code in gitamine's column placement:

```typescript
// commit-graph.ts line 157 — the ONLY stash reference:
this.positions.set(commitSha, [i, j, 
    repo.stashes.has(commitSha) ? NodeType.Stash : NodeType.Commit
]);
```

Everything else is handled by general-purpose code:
1. **Second parent hiding** (repo-wrapper.ts:242-246): removes stash's
   internal parents (index tree, untracked tree) from the commit list entirely.
   This is done BEFORE graph computation.
2. **Node rendering** (graph-canvas.tsx:119-123): filled square instead of
   filled circle. That's it.

No special column logic, no dashed edges, no lane tracking, no interleaving.

### Trunk: Three Special Mechanisms

Six, when this comparison was written. Three of them are gone: `stash_by_parent` plus its
interleaving and the orphan stash guard were deleted on 2026-08-03 when stashes started
riding the revwalk, and `stash_lanes` went in `4a9f15e`.

1. `PlacementInput.stashes` — identifies stashes
2. `is_stash` flag on output — affects frontend rendering
3. Parent filtering in Phase 4 — only tracks first parent

### How Stashes Place in Gitamine (Traced Example)

Setup: HEAD chain A→B→C at col 0. Stash S with parent B.

```
Topological order: A, S, B, C  (children before parents)

Process A (HEAD):
  → commitToReplace = 'index' at col 0
  → branches = [A]
  → position: (0, 0)

Process S (stash):
  → children = [] (nothing has S as a parent)
  → No branchChildren, no commitToReplace
  → children.length === 0 → insertCommit(S, near col 0, {})
  → branches[0] = A (occupied), try col 1 → append
  → branches = [A, S]
  → position: (1, 1)

Process B (HEAD chain):
  → children = [A, S]
  → branchChildren = [A, S] (both have B as first parent)
  → Pick leftmost non-forbidden: A at col 0
  → Replace A at col 0: branches = [B, S]
  → Remove other branchChildren: S at col 1 → branches = [B, null]
  → position: (2, 0)
  
Process C:
  → branchChildren = [B]
  → Replace B at col 0
  → position: (3, 0)
```

Result:
```
  col 0  col 1
    ●           ← A (HEAD)
           ■    ← S (stash) — at col 1, NOT inline with parent
    ●           ← B — at col 0, replaced A
    ●           ← C — at col 0, replaced B
```

**Important**: In gitamine, the stash is NOT inline with its parent either.
It's at col 1 (next to parent at col 0). The parent picks the HEAD chain
child (leftmost) over the stash. A branch edge connects S(col 1) to B(col 0).

The difference from Trunk: the stash is at col **1** (nearby), not col **20+**
(far away). This is because of `insertCommit`'s proximity search vs Trunk's
linear scan.

### When IS a Stash Inline in Gitamine?

A stash is inline (same column as parent) ONLY when:
- The stash is the parent's ONLY branch child, OR
- The stash has the leftmost column among all branch children

Example: branch at col 3, stash on that branch (no HEAD chain competition):
```
Process S: insertCommit near col 0 → gets col 0 (free)
Process B: only branchChild is S at col 0 → replace → B at col 0
→ Both at col 0 = inline!
```

---

## Part 5: Structural Comparison — Trunk vs Gitamine

### The Seven Key Differences

| # | Aspect | Gitamine | Trunk |
|---|--------|----------|-------|
| 1 | Column mechanism | Parent **replaces** child's column | Child **reserves** column for parent via `pending_parents` |
| 2 | HEAD chain | Only HEAD gets special treatment (replaces 'index' at col 0) | ALL HEAD ancestors pre-reserved at col 0 |
| 3 | Free column search | `insertCommit()` — spiral outward from target | Linear scan from col 1, first available |
| 4 | Forbidden indices | Computed from merge children's occupied columns | Not implemented |
| 5 | Edge emission | Post-processing from positions | Inline during column layout |
| 6 | Stash handling | Zero special logic | 3 special mechanisms |
| 7 | Color strategy | `color = col % N` (deterministic) | `lane_colors` HashMap with counter |

### Why Stashes End Up Far Right in Trunk

> **STALE as of 2026-08-03.** Two premises below no longer hold: stashes are pushed into the
> revwalk and ordered topologically, not "interleaved before parent" and not merged by
> committer timestamp (`graph.rs`, `capture` Step 2), and a stash on a clean worktree's HEAD tip is
> placed inline at column 0 rather than far right (`can_inline`). `5b29894` ("compact stash
> placement via temporal sort and proximity search") already addressed the far-right
> complaint this section describes.

Root cause chain:
1. HEAD chain pre-reservation puts ALL HEAD ancestors into `pending_parents[oid] = 0`
2. Stash is processed (it sorts above its parent, so it is reached first)
3. Stash has no `pending_parents` entry → goes to free-column scan
4. Free-column scan starts at col 1, skips occupied cols (dependabot at 1-19)
5. Stash lands at col 20+ (first free)
6. Parent already reserved at col 0 → fork edge spans 20 columns
7. Connection is barely visible or broken

### Why Gitamine Doesn't Have This Problem

1. No HEAD chain pre-reservation → no column conflict
2. `insertCommit` with proximity search → stash lands near parent
3. Parent uses "replace" mechanism → takes leftmost branch child's column
4. Stash ends up at most 1-2 columns away from parent

---

## Part 6: Applicable Learnings for Trunk

### Concept 1: Replace Mechanism (adopt)

The "parent replaces child's column" concept should be adopted. It's what
makes first-parent chains straight without explicit reservation. In Trunk's
architecture, this would mean:

When processing a commit that is in `pending_parents`:
- Instead of just using the reserved column, also check if any of the
  commit's branch children have columns that should be freed
- This is already partially done via fork-in detection in Phase 2

### Concept 2: Proximity-Based Column Search (adopt)

Replace the linear scan with a spiral search centered on a target column.
For a stash, the target should be its parent's column. For a new branch,
the target should be near its first child's column. This alone would fix
the "stash at column 20" problem.

### Concept 3: Forbidden Indices (consider for later)

Prevents merge edges from crossing occupied lanes. Not strictly necessary
for the stash fix, but would improve graph readability for complex merge
topologies. Could be added as a separate improvement.

### Concept 4: Post-Processing Edges (consider for later)

Separating column assignment from edge emission would reduce coupling and
make the algorithm easier to modify. However, this is a major refactor of
placement.rs and the downstream TypeScript layers depend on the current edge
format. Consider for a future cleanup.

### Concept 5: Eliminate HEAD Chain Pre-Reservation (consider)

Instead of pre-reserving all HEAD chain members at col 0, handle HEAD like
gitamine does: just make HEAD replace 'index' at col 0, and let the first-
parent chain inherit col 0 through normal first-parent processing. This
would eliminate the `pending_parents` conflict that causes stash displacement.

However, this is the riskiest change because the HEAD chain pre-reservation
is foundational to Trunk's current algorithm. It ensures col 0 is always
the HEAD lane regardless of processing order. Removing it requires careful
verification.

Since 2026-08-05 that reservation covers more than HEAD's ancestors: it also
covers the chain continuing HEAD's tip upward, so a branch that is merely
behind renders straight. See `head_lane_extension` in `placement.rs` and
`docs/architecture/commit-graph.md` §"HEAD lane pre-reservation".

### Concept 6: Simplify Stash Handling (adopt)

Remove stash-specific mechanisms from column assignment. Stashes should go
through the exact same codepath as any other commit. The only stash-specific
code should be:
1. Second parent filtering (ignore index/untracked parents)
2. Visual marker (`is_stash` flag → dashed square + dashed edges)
3. ~~Orphan stash detection (parent not reachable → standalone dot)~~ — **dropped
   2026-08-03.** Stashes ride the revwalk, so a stash's parent is always in the walk and
   gets a row of its own; there is no orphan case left to detect. Items 1 and 2 were
   adopted.

---

## Appendix: File Reference

### Gitamine Source (cloned to /tmp/gitamine)

| File | Role |
|------|------|
| `src/renderer/helpers/commit-graph.ts` | Column placement + interval tree (174 lines) |
| `src/renderer/helpers/repo-wrapper.ts` | Sorting, stash parent hiding, children/parents maps (741 lines) |
| `src/renderer/components/graph-canvas.tsx` | Canvas rendering: nodes + edges (176 lines) |
| `src/renderer/components/graph-viewer.tsx` | Graph + commit list layout (130 lines) |

### Blog Post Key Sections

1. **Types of algorithms**: one-commit-per-row, straight vs curved branches
2. **Temporal topological sort**: date-aware topological ordering
3. **Curved branches algorithm**: simple active branch list
4. **Straight branches algorithm**: replace mechanism + forbidden indices
5. **Optimizations**: visible-area-only rendering, interval tree for edge visibility
