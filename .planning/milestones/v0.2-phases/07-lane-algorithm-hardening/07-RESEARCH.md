# Phase 7: Lane Algorithm Hardening - Research

**Researched:** 2026-03-09
**Domain:** Rust git commit graph lane assignment algorithm
**Confidence:** HIGH

## Summary

This phase hardens the existing single-pass lane assignment algorithm in `src-tauri/src/git/graph.rs` to eliminate ghost lanes, handle octopus merges without column explosion, produce consistent SVG widths, and reuse freed columns compactly. The algorithm already has the correct skeleton (topological walk, `active_lanes` + `pending_parents`, HEAD chain pre-computation, pass-through edge emission). The work is about fixing four specific deficiencies in lane lifecycle management, adding a `max_columns` output field, and introducing a per-branch `color_index` counter.

No new crates are needed. The existing `git2 0.19` + `tempfile 3` stack is sufficient. The primary risk is regression -- the 7 existing graph tests must continue to pass while new topology tests are added. The algorithm remains single-pass O(n) where n is the total commit count.

**Primary recommendation:** Fix the four identified algorithmic bugs in `walk_commits()`, add `max_columns` tracking, implement deterministic `color_index` assignment, wrap the return type in a new `GraphResult` struct, and add test fixtures for octopus merge, ghost lane, and criss-cross merge topologies.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Leftmost available column reuse -- always grab the first free slot (most compact, GitKraken behavior)
- Immediate reuse -- freed columns available on the very next row, no gap/delay
- Column 0 reserved for HEAD's first-parent chain (existing behavior, keep it)
- Octopus merges: each parent gets its own column, no collapsing -- graph widens temporarily then narrows as freed lanes are reclaimed
- Global max across entire repo -- compute max active lanes across ALL commits, every row SVG uses that width
- Algorithm outputs `max_columns` as a top-level field alongside commit rows (single source of truth for frontend)
- No hard cap on maximum columns -- let graph grow as wide as needed
- All active lanes emit pass-through edges on every row (Phase 8 needs this for continuous vertical rails)
- Add `color_index` per branch in this phase (not deferred to Phase 8) -- monotonically increasing counter, HEAD gets 0
- Each `GraphEdge` includes `color_index` of its source branch
- Merge edges use the source (merged-in) branch color
- Fork edges use the new (forking) branch color
- Pass-through edges use their own branch's color_index
- Deterministic: same repo always produces same color assignments

### Claude's Discretion
- Internal data structures for lane tracking (active_lanes, pending_parents redesign)
- Test fixture design for complex topologies (octopus merges, criss-cross merges, long-running branches)
- Algorithm optimization approach (single-pass vs multi-pass)
- Edge case handling for orphan commits, shallow clones, grafts

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ALGO-01 | Lane algorithm produces no ghost lanes (cleared lanes must not render in subsequent rows) | Identified root cause: `active_lanes` slot not cleared when a merge causes first-parent to redirect to an already-claimed column (line 94-126 in graph.rs). Fix requires explicit lane termination at merge points. |
| ALGO-02 | Lane algorithm handles octopus merges (3+ parents) without graph width explosion | Secondary parent column search (line 145) does not skip column 0, allowing octopus parents to steal HEAD's column. Each parent allocates a new column but these are properly freed when those commits are processed later. Width explosion is prevented by leftmost-available reuse, but column 0 protection is missing. |
| ALGO-03 | All commit rows have consistent SVG width based on max active columns (no message column jitter) | No `max_columns` field exists. `LaneSvg.svelte` uses `(commit.column + 1) * laneWidth` per row. Fix: track `max_columns` during walk, return in new wrapper struct, frontend uses it for all rows. |
| LANE-05 | User sees a compact graph where freed columns are reclaimed after branch merges | Leftmost-available search exists (line 71) but only applies to new branch tips. After a merge, the merged branch's column becomes `None` in `active_lanes` but the search for column reuse only fires when a brand-new chain starts (i.e., a commit not in `pending_parents`). This works correctly for future branches -- the issue is ghost lanes (ALGO-01), not reuse failure. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 | Git repository access (revwalk, commit lookup, refs) | Already in use, vendored libgit2 |
| serde | 1 | Serialization for Tauri IPC | Already in use |
| tempfile | 3 (dev) | Temporary repos for tests | Already in use |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None needed | - | - | No new dependencies for this phase |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom lane algorithm | `gix` crate's graph module | gix has no lane assignment -- it only does commit traversal, not visual layout |
| `Vec<Option<Oid>>` for active_lanes | `HashMap<usize, Oid>` | Vec gives O(1) column lookup and natural leftmost-available scan; HashMap wastes that |

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/git/
  graph.rs          # walk_commits() algorithm -- ALL changes here
  types.rs          # GraphResult wrapper, color_index on GraphCommit
  repository.rs     # Unchanged
  mod.rs            # Unchanged
```

### Pattern 1: Wrapper Return Type (GraphResult)

**What:** Instead of returning `Vec<GraphCommit>`, return a `GraphResult` struct containing both the commits and metadata.
**When to use:** When the algorithm needs to communicate global properties (max_columns) alongside per-row data.
**Example:**
```rust
// In types.rs
#[derive(Debug, Serialize, Clone)]
pub struct GraphResult {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
}
```

This propagates through: `walk_commits() -> GraphResult`, `CommitCache` stores `GraphResult`, `get_commit_graph` returns the page slice + max_columns, TypeScript gets `{ commits: GraphCommit[], max_columns: number }`.

### Pattern 2: Branch Color Counter

**What:** A monotonically increasing counter assigned when a new branch chain is first encountered.
**When to use:** When deterministic, stable color assignment is needed per-branch.
**Example:**
```rust
// Inside walk_commits(), alongside active_lanes/pending_parents:
let mut next_color: usize = 0;
let mut lane_color: HashMap<usize, usize> = HashMap::new(); // column -> color_index

// HEAD chain gets color 0
lane_color.insert(0, 0);
next_color = 1;

// When a new chain starts at column `col`:
let color = next_color;
next_color += 1;
lane_color.insert(col, color);

// When a branch moves columns (merge redirect):
// color follows the branch, not the column
```

### Pattern 3: Explicit Lane Lifecycle

**What:** Three-phase lane management: ACTIVATE (assign column) -> PASSTHROUGH (emit straight edges) -> TERMINATE (free column).
**When to use:** Every commit row. The current code partially does this but has gaps at merge points.
**Example:**
```rust
// Phase 1: Find column for this commit
let col = find_or_assign_column(oid, &mut active_lanes, &mut pending_parents);

// Phase 2: Emit pass-through edges for all OTHER active lanes
// (before consuming this commit's slot)
let edges = emit_passthrough_edges(&active_lanes, col);

// Phase 3: Consume this slot, assign parent columns
active_lanes[col] = None;  // TERMINATE current occupant
// Then for each parent: ACTIVATE or redirect
```

### Anti-Patterns to Avoid
- **Column-as-color:** Current code uses `color_index: other_col` (column position as color). This breaks when columns are reused -- two different branches in the same column at different times would share a color. Must use the branch color counter instead.
- **Head chain in pending_parents:** Pre-populating ALL head chain OIDs in `pending_parents` is O(depth) memory and prevents those columns from being "found" by the normal search. Keep the pre-population but be aware it means head chain commits never go through the "new chain" path.
- **Secondary parent skipping column 0:** The secondary parent search (line 145) uses `active_lanes.iter().position(|s| s.is_none())` without skipping column 0. This must use the same `start_col` logic as the primary new-chain search.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Topological ordering | Custom sort | `git2::Sort::TOPOLOGICAL \| git2::Sort::TIME` via revwalk | Already correct, battle-tested |
| Test repo creation | Manual git commands | `git2::Repository::init()` + in-memory commits via `repo.commit()` | Existing test pattern, no shell dependency |
| Cross-platform path handling | String manipulation | `std::path::PathBuf` | Already used throughout |

**Key insight:** This phase is pure algorithm hardening -- no new infrastructure is needed. The test fixtures for complex topologies (octopus, criss-cross) are the most effort-intensive new code.

## Common Pitfalls

### Pitfall 1: Ghost Lanes from First-Parent Redirect at Merge

**What goes wrong:** When a merge commit's first parent is already claimed by another branch (in `pending_parents`), the code emits a ForkLeft/ForkRight edge from the current column to the existing column, then leaves the current column's `active_lanes[col]` as `None`. This is correct -- the lane terminates. BUT: the pass-through edge emission (line 80-92) runs BEFORE `active_lanes[col] = None` (line 96). Since the commit's own slot was already `Some(oid)` when pass-through edges are emitted, it doesn't matter because the code explicitly skips `other_col != col`. The real ghost lane issue is subtler: if a branch merges and its column is freed, but then a subsequent commit's pass-through emission still sees `Some` in that column because the OID lingers from a previous pending_parents entry that was never consumed.
**Why it happens:** The `pending_parents` pre-population for head_chain inserts entries that may never be consumed if the repo has orphan branches or if the walk terminates early.
**How to avoid:** After processing each commit, verify that `active_lanes[col]` is only `Some` if the OID actually appears later in the remaining walk. Pragmatically: clear `active_lanes` entries when `pending_parents` entries are consumed, and ensure parentless commits (roots) leave no lingering `active_lanes` entries.
**Warning signs:** A test where after a merge, subsequent rows still show a Straight edge in the merged branch's former column.

### Pitfall 2: Octopus Merge Column 0 Theft

**What goes wrong:** Secondary parent column assignment (line 145) searches from index 0, so an octopus merge can place a secondary parent in column 0 if it happens to be empty at that moment.
**Why it happens:** The column 0 reservation logic only applies to the "new chain" path (line 70-71), not the secondary parent path.
**How to avoid:** Apply the same `start_col` logic to secondary parent column search. If `head_chain` is non-empty, skip column 0.
**Warning signs:** A test with an octopus merge where one of the secondary parents gets column 0.

### Pitfall 3: Color Instability After Column Reuse

**What goes wrong:** If `color_index` is tied to column number (current behavior), then when column 2 is freed by branch A and later reused by branch B, branch B inherits the same color as branch A.
**Why it happens:** Column reuse is by design (LANE-05), but color-from-column conflates position with identity.
**How to avoid:** Maintain a separate `lane_color: HashMap<usize, usize>` mapping column to color_index. When a column is freed, remove its color entry. When a new branch takes the column, assign a new color_index from the monotonic counter.
**Warning signs:** Two unrelated branches at different times showing the same color.

### Pitfall 4: max_columns Off-By-One

**What goes wrong:** `max_columns` might be computed as the maximum column index rather than the count, leading to an off-by-one error in SVG width calculation.
**Why it happens:** `active_lanes.len()` gives the count (1-indexed), but the maximum column index is 0-indexed. If you track `max_columns` as a high-water mark of `active_lanes.len()`, it's correct. If you track the maximum assigned column index, you need `+ 1`.
**How to avoid:** Track `max_columns` as `active_lanes.len()` (the count, not the index). Update it after any resize or push to `active_lanes`.
**Warning signs:** Frontend SVG is 1 lane too narrow or too wide.

### Pitfall 5: Regression in Pagination

**What goes wrong:** `walk_commits()` currently processes ALL OIDs for lane continuity but only returns the page slice. The `GraphResult.max_columns` must reflect the GLOBAL max, not just the page max.
**Why it happens:** It's tempting to compute max_columns only from `page_oids`, but lanes outside the page window affect the global width.
**How to avoid:** Track max_columns during the full walk (step 4), not during the page extraction (step 5).
**Warning signs:** Different pages showing different SVG widths.

### Pitfall 6: Root Commits Leave Orphan active_lanes Entries

**What goes wrong:** A root commit (no parents) has its `active_lanes[col]` set to `None` in step "Consume this commit's slot" but the slot was already consumed. If the root commit was previously in `pending_parents` (head_chain member), the slot was occupied by `Some(root_oid)`. After `active_lanes[col] = None`, the lane is properly freed. But if the root is NOT in head_chain, it went through the "new chain" path and got a fresh column -- which is then consumed and freed. This is actually correct, but needs a test to verify.
**How to avoid:** Add a test for orphan root commits (repos with multiple roots, like after a `git merge --allow-unrelated-histories`).
**Warning signs:** Root commit row still shows active lanes in its former column.

## Code Examples

### Example 1: GraphResult Wrapper Type
```rust
// types.rs - new struct
#[derive(Debug, Serialize, Clone)]
pub struct GraphResult {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
}
```

### Example 2: Fixed Secondary Parent Column Search (skip column 0)
```rust
// graph.rs - inside the secondary parent assignment block
let start_col = if !head_chain.is_empty() { 1 } else { 0 };
let c = if let Some(i) = active_lanes.iter().skip(start_col).position(|s| s.is_none()) {
    i + start_col
} else {
    active_lanes.push(None);
    active_lanes.len() - 1
};
```

### Example 3: max_columns Tracking
```rust
// graph.rs - inside walk_commits(), after the main loop setup
let mut max_columns: usize = 0;

// Inside the loop, after any active_lanes modification:
max_columns = max_columns.max(active_lanes.len());

// After the loop, in the return:
Ok(GraphResult { commits: result, max_columns })
```

### Example 4: Branch Color Counter
```rust
// graph.rs - inside walk_commits()
let mut next_color: usize = 1; // 0 reserved for HEAD
let mut lane_colors: HashMap<usize, usize> = HashMap::new(); // column -> color_index
lane_colors.insert(0, 0); // HEAD chain always color 0

// When assigning a new branch to column `col`:
let color = next_color;
next_color += 1;
lane_colors.insert(col, color);

// When emitting edges:
// Pass-through edge at column `c`: color_index = lane_colors[&c]
// Merge edge from col to parent_col: color_index = lane_colors[&col] (source branch)
// Fork edge from col to parent_col: color_index = lane_colors[&parent_col] (new branch)
// First-parent straight: color_index = lane_colors[&col] (same branch continues)

// When a column is freed (branch merges in):
lane_colors.remove(&col);
// When a new branch takes the freed column:
lane_colors.insert(col, next_color);
next_color += 1;
```

### Example 5: Octopus Merge Test Fixture
```rust
#[test]
fn octopus_merge_no_column_explosion() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    // ... config setup ...
    let sig = git2::Signature::now("T", "t@t.com").unwrap();

    // Create root commit
    // Create 3 branches from root: branch-a, branch-b, branch-c
    // Create octopus merge on main with all 3 as parents
    // Assert: max_columns <= 4 (main + 3 branches)
    // Assert: after the octopus merge row, only 1 active lane remains (main -> root)
    // Assert: no secondary parent in column 0
}
```

### Example 6: Ghost Lane Test Fixture
```rust
#[test]
fn no_ghost_lanes_after_merge() {
    // Create: main (C0 -> C1 -> M), feature (C0 -> F1), M merges F1
    // After row M: feature's column should have NO pass-through edge
    // After row M: only main's column (0) should have a Straight edge to C1
    let dir = tempfile::tempdir().unwrap();
    // ... build repo ...
    let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    // Find the commit BELOW the merge (C1)
    let c1 = commits.iter().find(|c| c.summary == "C1").unwrap();
    // C1 should NOT have a pass-through edge at feature's former column
    let feature_col = commits.iter().find(|c| c.summary == "F1").unwrap().column;
    let ghost = c1.edges.iter().any(|e| {
        e.from_column == feature_col && e.to_column == feature_col
            && matches!(e.edge_type, EdgeType::Straight)
    });
    assert!(!ghost, "ghost lane detected at column {} on commit C1", feature_col);
}
```

### Example 7: Consistent Width Test
```rust
#[test]
fn all_rows_same_max_columns() {
    let dir = make_test_repo();
    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    // result.max_columns is the global max
    for commit in &result.commits {
        assert!(commit.column < result.max_columns,
            "commit {} at column {} >= max_columns {}",
            commit.short_oid, commit.column, result.max_columns);
    }
}
```

### Example 8: GraphCommit with color_index field
```rust
// types.rs - add field to GraphCommit
#[derive(Debug, Serialize, Clone)]
pub struct GraphCommit {
    // ... existing fields ...
    pub column: usize,
    pub color_index: usize,  // NEW: per-branch color, HEAD=0
    pub edges: Vec<GraphEdge>,
    // ...
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Color from column index | Monotonic counter per branch | This phase | Stable colors survive column reuse |
| Per-row SVG width | Global max_columns | This phase | No message column jitter |
| Return `Vec<GraphCommit>` | Return `GraphResult { commits, max_columns }` | This phase | Frontend gets width from backend |

**Deprecated/outdated:**
- `color_index: other_col` pattern (using column as color) -- replaced by branch color counter
- `svgWidth = (commit.column + 1) * laneWidth` in LaneSvg.svelte -- will use `max_columns * laneWidth` (Phase 8 renders lanes, but width fix is Phase 7 data)

## Open Questions

1. **How should orphan commits (multiple roots) be colored?**
   - What we know: Each root starts a new chain. The first-parent root of HEAD gets color 0. Other roots get incrementing colors.
   - What's unclear: Should orphan branches that were merged via `--allow-unrelated-histories` get a special treatment?
   - Recommendation: Treat them as normal new branches -- assign next_color. Add a test fixture for this edge case.

2. **Should the CommitCache store GraphResult or Vec<GraphCommit> + max_columns separately?**
   - What we know: `CommitCache` currently stores `Vec<GraphCommit>`. The `get_commit_graph` command slices it.
   - What's unclear: Whether to store `GraphResult` as a whole or destructure it.
   - Recommendation: Store `GraphResult` directly. The slicing in `get_commit_graph` returns `{ commits: slice, max_columns: result.max_columns }`.

3. **Should color_index be added to GraphCommit or kept only on edges?**
   - What we know: CONTEXT.md says "Add color_index per branch in this phase" and "Each GraphEdge includes color_index of its source branch".
   - What's unclear: Whether the commit node itself needs a color_index (for the dot color in the SVG).
   - Recommendation: Add `color_index` to both `GraphCommit` (for the dot) and `GraphEdge` (for the lines). The commit's color_index is its branch's color.

## Integration Points Summary

Changes propagate through these files:

| File | Change | Reason |
|------|--------|--------|
| `src-tauri/src/git/types.rs` | Add `GraphResult`, add `color_index` to `GraphCommit` | New return type, new field |
| `src-tauri/src/git/graph.rs` | Algorithm fixes, max_columns tracking, color counter | Core algorithm hardening |
| `src-tauri/src/state.rs` | `CommitCache` stores `GraphResult` instead of `Vec<GraphCommit>` | Wrapper type change |
| `src-tauri/src/commands/repo.rs` | `open_repo` stores `GraphResult` | Type change propagation |
| `src-tauri/src/commands/history.rs` | `get_commit_graph` returns commits slice + max_columns | API change |
| `src/lib/types.ts` | Add `GraphResult` interface, add `color_index` to `GraphCommit` | TypeScript mirror |
| `src/components/LaneSvg.svelte` | Accept `maxColumns` prop, use for SVG width | Consistent width |
| `src/components/CommitGraph.svelte` | Pass `maxColumns` from response to `CommitRow` | Data flow |
| `src/components/CommitRow.svelte` | Pass `maxColumns` to `LaneSvg` | Data flow |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[cfg(test)]` + `cargo test` |
| Config file | None needed -- Rust test runner is built-in |
| Quick run command | `cd src-tauri && cargo test --lib git::graph` |
| Full suite command | `cd src-tauri && cargo test --lib` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ALGO-01 | No ghost lanes after merge | unit | `cd src-tauri && cargo test --lib git::graph::tests::no_ghost_lanes_after_merge -- --exact` | Wave 0 |
| ALGO-01 | No ghost lanes after criss-cross merge | unit | `cd src-tauri && cargo test --lib git::graph::tests::no_ghost_lanes_criss_cross -- --exact` | Wave 0 |
| ALGO-02 | Octopus merge stays compact | unit | `cd src-tauri && cargo test --lib git::graph::tests::octopus_merge_compact -- --exact` | Wave 0 |
| ALGO-02 | Octopus merge does not steal column 0 | unit | `cd src-tauri && cargo test --lib git::graph::tests::octopus_no_column_zero_theft -- --exact` | Wave 0 |
| ALGO-03 | All commits within max_columns | unit | `cd src-tauri && cargo test --lib git::graph::tests::consistent_max_columns -- --exact` | Wave 0 |
| ALGO-03 | max_columns stable across pages | unit | `cd src-tauri && cargo test --lib git::graph::tests::max_columns_pagination -- --exact` | Wave 0 |
| LANE-05 | Freed columns reused by new branches | unit | `cd src-tauri && cargo test --lib git::graph::tests::freed_column_reuse -- --exact` | Wave 0 |
| ALL | color_index deterministic | unit | `cd src-tauri && cargo test --lib git::graph::tests::color_index_deterministic -- --exact` | Wave 0 |
| ALL | color_index HEAD is 0 | unit | `cd src-tauri && cargo test --lib git::graph::tests::color_index_head_zero -- --exact` | Wave 0 |
| ALL | Existing tests still pass | regression | `cd src-tauri && cargo test --lib git::graph` | Existing (7 tests) |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test --lib git::graph`
- **Per wave merge:** `cd src-tauri && cargo test --lib`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/git/graph.rs::tests::no_ghost_lanes_after_merge` -- covers ALGO-01
- [ ] `src-tauri/src/git/graph.rs::tests::no_ghost_lanes_criss_cross` -- covers ALGO-01
- [ ] `src-tauri/src/git/graph.rs::tests::octopus_merge_compact` -- covers ALGO-02
- [ ] `src-tauri/src/git/graph.rs::tests::octopus_no_column_zero_theft` -- covers ALGO-02
- [ ] `src-tauri/src/git/graph.rs::tests::consistent_max_columns` -- covers ALGO-03
- [ ] `src-tauri/src/git/graph.rs::tests::max_columns_pagination` -- covers ALGO-03
- [ ] `src-tauri/src/git/graph.rs::tests::freed_column_reuse` -- covers LANE-05
- [ ] `src-tauri/src/git/graph.rs::tests::color_index_deterministic` -- covers color model
- [ ] `src-tauri/src/git/graph.rs::tests::color_index_head_zero` -- covers color model
- [ ] Helper: `make_octopus_repo()` fixture in `repository.rs::tests`
- [ ] Helper: `make_ghost_lane_repo()` fixture in `repository.rs::tests`

## Sources

### Primary (HIGH confidence)
- Existing source code: `src-tauri/src/git/graph.rs` (422 lines, read in full)
- Existing source code: `src-tauri/src/git/types.rs` (163 lines, read in full)
- Existing source code: `src-tauri/src/state.rs`, `commands/repo.rs`, `commands/history.rs` (read in full)
- Existing source code: `src/components/LaneSvg.svelte`, `CommitGraph.svelte`, `CommitRow.svelte` (read in full)
- Existing source code: `src/lib/types.ts` (read in full)
- `cargo test --lib` output: all 41 tests pass (verified 2026-03-09)

### Secondary (MEDIUM confidence)
- [pvigier's blog: Commit Graph Drawing Algorithms](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html) - straight_branches algorithm, forbidden index sets, nil-based lane freeing
- [DoltHub blog: Drawing a Commit Graph](https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/) - column classification (head/branch-child/merge-only), lane reuse strategy
- [Git core graph.c](https://github.com/git/git/blob/master/graph.c) - column struct, graph_find_new_column_by_commit, swap-based column recycling, color as index into column_colors array
- [git-cola PR #654](https://github.com/git-cola/git-cola/pull/654) - simplified column assignment detecting freed columns during child processing

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies, existing code fully read and tests verified
- Architecture: HIGH - Algorithm is well-understood, bugs are identified with line numbers, fix patterns are clear
- Pitfalls: HIGH - Derived from direct code analysis, not speculation
- Color model: MEDIUM - Design is specified in CONTEXT.md but implementation details (edge coloring semantics for merge vs fork) may need iteration during implementation

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable domain -- git2 0.19 is the current version, algorithm patterns are evergreen)
