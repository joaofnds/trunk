---
status: diagnosed
trigger: "Investigate why lane colors switch at batch boundaries in the commit graph"
created: 2026-03-08T00:00:00Z
updated: 2026-03-08T00:00:00Z
---

## Current Focus

hypothesis: NOT A BUG IN CURRENT ARCHITECTURE -- lane colors cannot switch at batch boundaries because batching is purely a frontend concern; the backend computes the full graph in one pass
test: Trace the full data pipeline from walk_commits through CommitCache to frontend rendering
expecting: Confirm that color_index values are computed once and served verbatim to the frontend
next_action: Write up diagnosis

## Symptoms

expected: A lane that starts as green in batch 1 should remain green in batch 2
actual: Reported that lane lines change color when scrolling past ~200th commit (batch boundary)
errors: none
reproduction: Scroll past 200th commit in repos with multiple active lanes
started: unknown

## Eliminated

- hypothesis: walk_commits is called per-batch with skip/offset, re-initializing lane state each time
  evidence: |
    In `open_repo` (commands/repo.rs:21), walk_commits is called ONCE with `(0, usize::MAX)`,
    computing the ENTIRE graph in a single pass. The result is stored in CommitCache.
    `get_commit_graph` (commands/history.rs:17-20) merely slices the cached Vec by offset:
    `commits[start..end].to_vec()`. It never calls walk_commits again.
    Therefore, lane assignment and color_index values are computed once, globally, and are
    consistent across all "batches". The backend has no batch boundary at all.
  timestamp: 2026-03-08

- hypothesis: color_index is assigned per-batch, causing different indices for the same lane in different slices
  evidence: |
    color_index is set equal to the column index (e.g., graph.rs:61 `color_index: other_col`,
    graph.rs:90 `color_index: existing_col`, graph.rs:104 `color_index: col`,
    graph.rs:147 `color_index: parent_col`). Column assignment is done in the single full pass
    over ALL oids (graph.rs:34-152). The per_oid_data HashMap stores (column, edges) computed
    during this single pass, and page_oids merely selects which entries to include in output.
    Since color_index = column, and columns are assigned in a single global pass, the same
    lane always gets the same color_index regardless of which "page" it appears on.
  timestamp: 2026-03-08

- hypothesis: Frontend re-maps or re-computes color_index when concatenating batches
  evidence: |
    CommitGraph.svelte:38 does `commits.push(...batch)` -- pure array concatenation, no
    transformation. CommitRow.svelte passes the commit object as-is to LaneSvg.svelte.
    LaneSvg.svelte:34,42 uses `edge.color_index` directly via `laneColor(edge.color_index)`.
    laneColor (LaneSvg.svelte:14) is `var(--lane-${idx % 8})` -- a pure function of the
    color_index value from the backend. No frontend state, no re-computation, no batch-aware logic.
  timestamp: 2026-03-08

## Evidence

- timestamp: 2026-03-08
  checked: Backend call chain for graph data
  found: |
    open_repo (commands/repo.rs:17-22) calls walk_commits(&mut repo, 0, usize::MAX) -- a single
    pass over ALL commits. The result (Vec<GraphCommit>) is stored in CommitCache (state.rs:12).
    get_commit_graph (commands/history.rs:12-20) reads from CommitCache and slices by offset.
    It NEVER calls walk_commits. There is no per-batch graph computation.
  implication: Lane state (column assignments, color_index values) is computed once globally. No batch boundary exists in the backend.

- timestamp: 2026-03-08
  checked: color_index assignment in walk_commits (graph.rs)
  found: |
    color_index is always set to the column index of the target lane:
    - Straight pass-through edges: color_index = other_col (line 61)
    - First-parent already-claimed edges: color_index = existing_col (line 90)
    - First-parent continuation edges: color_index = col (line 104)
    - Secondary parent edges: color_index = parent_col (line 147)
    Column assignment uses a single set of active_lanes and pending_parents across ALL oids.
  implication: color_index is deterministic and globally consistent. A lane at column N always has color_index N.

- timestamp: 2026-03-08
  checked: Frontend batch concatenation and rendering pipeline
  found: |
    CommitGraph.svelte fetches batches via safeInvoke('get_commit_graph', {path, offset}).
    Batches are concatenated with commits.push(...batch) -- no transformation.
    LaneSvg.svelte renders edges using edge.color_index directly.
    laneColor = var(--lane-${idx % 8}) with 8 CSS custom properties (app.css:13-20).
  implication: Frontend faithfully renders whatever color_index the backend provides. No re-mapping.

- timestamp: 2026-03-08
  checked: Whether column positions can shift at batch boundaries
  found: |
    Column assignment depends on active_lanes state, which evolves as commits are processed.
    A lane that is in column 2 at commit 199 stays in column 2 at commit 200 because
    walk_commits processes all commits in one pass. The "batch" is just a slice of the output.
    HOWEVER: there is one scenario where color COULD appear to change visually:
    If a lane ENDS (its chain terminates) and a NEW lane later reuses the same column index,
    the new lane would have the same color_index (same column) but represents a different branch.
    This is correct behavior -- same column = same color -- but could look like a "color switch"
    if the user perceives it as the same branch continuing.
  implication: The only way colors "change" at a batch boundary is coincidental: a lane terminates and another lane reuses the column near the boundary, which is a topology artifact, not a bug.

- timestamp: 2026-03-08
  checked: Commit dot color vs edge color
  found: |
    LaneSvg.svelte:53 colors the commit dot with `laneColor(commit.column % 8)`.
    Edge colors use `laneColor(edge.color_index)` where color_index = column of the target lane.
    These are consistent. But if a commit's column changes (e.g., a merge causes lane compaction),
    the commit dot color changes. This is correct: the commit moved columns.
  implication: No inconsistency between dot and edge coloring. Both derive from column position.

## Resolution

root_cause: |
  NOT A BUG IN CURRENT IMPLEMENTATION.

  The reported symptom ("lane colors switch at batch boundaries") cannot occur with the
  current architecture because:

  1. walk_commits is called ONCE with limit=usize::MAX in open_repo, computing the
     entire graph in a single pass with globally consistent lane/column assignments.

  2. get_commit_graph merely slices the pre-computed cached Vec by offset -- it never
     re-runs the graph algorithm.

  3. color_index = column index, assigned during the single global pass.

  4. The frontend concatenates batches without any transformation and renders
     color_index values directly.

  There are two possible explanations for the reported symptom:

  (A) LANE COLUMN REUSE: When a branch terminates (merges or ends), its column becomes
      free. A later commit may start a new branch in that same column. Near a batch
      boundary (~commit 200), the user may see one branch end and another begin in the
      same column with the same color, but perceive it as the "same" lane changing
      identity. This is correct behavior.

  (B) STALE OBSERVATION: The symptom may have been observed in an earlier version of the
      code where walk_commits was called per-batch (the function signature accepts offset
      and limit parameters, and the test `walk_second_batch` tests this pattern).
      If the architecture previously called walk_commits per-batch instead of caching
      the full result, lane colors WOULD switch because active_lanes would be
      re-initialized from scratch for each batch call. The current code avoids this
      by computing everything upfront.

  IMPORTANT LATENT RISK: The walk_commits function STILL accepts offset/limit parameters
  and the code path for per-batch computation still exists. If anyone changes open_repo
  to call walk_commits with a limited batch size (e.g., for performance with very large
  repos), the lane color switching bug would immediately appear because:
  - active_lanes starts empty on each call (graph.rs:30)
  - pending_parents starts empty on each call (graph.rs:31)
  - Column assignments would differ between calls since lane state is not carried over

fix: N/A (diagnosis only)
verification: N/A (diagnosis only)
files_changed: []
