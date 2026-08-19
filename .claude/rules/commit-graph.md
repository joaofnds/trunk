---
paths:
  - "src-tauri/src/git/graph.rs"
  - "src-tauri/src/git/placement.rs"
  - "src-tauri/src/git/graph_input.rs"
  - "src-tauri/src/git/layout_dump.rs"
  - "src-tauri/src/git/status.rs"
  - "src-tauri/src/git/types.rs"
  - "src/lib/types.ts"
  - "src/lib/active-lanes.ts"
  - "src/lib/wip-row.ts"
  - "src/lib/overlay-paths.ts"
  - "src/lib/overlay-visible.ts"
  - "src/lib/graph-constants.ts"
  - "src/components/CommitGraph.svelte"
  - "src-tauri/tests/test_graph.rs"
  - "src-tauri/tests/test_placement.rs"
  - "src-tauri/tests/test_graph_input.rs"
  - "src-tauri/tests/test_graph_goldens.rs"
---

# Commit Graph Rules

`graph.rs` reads the repository into plain data — every git2 call in the pipeline is here →
`placement.rs` assigns columns, colours and edges, a pure pass over that data →
`graph_input.rs` slices the page and hydrates its rows →
`wip-row.ts` prepends the WIP row → `active-lanes.ts` maps commits to overlay nodes and per-parent connections →
`overlay-paths.ts` emits SVG paths →
`overlay-visible.ts` culls off-screen paths, dots and pills → `CommitGraph.svelte` renders.

`layout_dump.rs` is not a pipeline stage (it is still pipeline source for the rules below):
it renders a `GraphResult` as the deterministic
text the committed layout text goldens are pinned against.
`docs/architecture/commit-graph.md` §File Map owns the full description.

## Binding rules

This file is the binding source for the constraints below. `docs/architecture/overview.md`,
`docs/architecture/commit-graph.md`, the staleness notes in
`docs/research/gitamine-graph-algorithm.md`, and `docs/commit-graph-changelog.md` all
paraphrase these rules or cite the pipeline source, often by `file.rs:NN` line number.
Repoint a stale citation to the file or symbol and drop the line number, so an unrelated edit
above it cannot silently stale it; a rename still surfaces in the sweep below (ruling
2026-08-07). Treat every such passage as a mirror to re-check, and read it as explanation of
a rule stated here, never as a doc that "code wins" may overwrite.

`docs/commit-graph-changelog.md` is a mirror like the rest, on one axis only: the identifiers
an entry names — symbols and source paths in its prose — are swept and corrected in place.
Everything else in an entry — what it claims changed and why, its date, its `Changed goldens`
list — is the record and is never rewritten (ruling 2026-08-07). The header above the first entry is
neither: `scripts/graph-accept.sh` owns its text — correct a stale identifier there first,
then mirror the same edit into the changelog.

- Never post-process the output of one stage to fix something an earlier stage should have
  done — the stages are interdependent and partial fixups desync. Fix the stage that owns the
  data; `docs/architecture/commit-graph.md` has the stage ownership
- Where a reference doc under `docs/` disagrees with the pipeline source — `graph.rs`,
  `placement.rs`, `graph_input.rs`, `status.rs`, `types.rs`, `layout_dump.rs` and the frontend modules in this
  rule's `paths:` list — or with the graph test suites, the code wins; correct the doc in the
  same change.
  The binding rules in *this* file do not yield that way: code that violates one is a bug in
  the code, not a rule to rewrite. Amend a rule's **substance** only when the user directs it,
  and record the date and the cause inline, as the bullets below do. Appending a dated
  re-derivation or revalidation note that a bullet itself asks for is not an amendment —
  record it yourself, in the bullet it belongs to
- After changing the pipeline, or a rule here, grep `docs/`, **this file's own prose and its `paths:`
  list, and the comments in the pipeline-source files and the graph test suites** for every symbol and mechanism the change touched, **including the ones it deleted**
  — a deleted mechanism is the one nothing points at any more, so nothing makes it surface.
  Correct every hit in the same change — in `docs/commit-graph-changelog.md`, only the
  identifiers in an entry's prose, per the carve-out above. Deleting the orphan-stash guard left three stale
  claims behind in `docs/architecture/commit-graph.md` and
  `docs/research/gitamine-graph-algorithm.md` (`34ee513`, 2026-08-03)
- Render a stash's graph marker as a dashed hollow **square** (`<rect>`) with dashed edges,
  never a circle. Hollow alone does not identify a stash: WIP is a dashed hollow **circle**, a
  merge is a solid-stroke hollow circle
- Stash *lane assignment* deliberately depends on worktree state: `can_inline` places a stash
  inline at its parent's column only when the worktree is clean, and branches it right
  otherwise. The frontend prepends the WIP row at the head-chain column whenever
  `wipCount > 0`, and an inline stash lands in that same column. Do not drop **or narrow** the
  `!worktree_dirty` clause — its dirtiness stays the shared `git::status::worktree_dirty`
  definition the WIP row is gated on, staged, unstaged, conflicted and untracked alike; a
  tighter predicate keeps the clause and still collides (amended 2026-08-02, after a
  TypeScript-only fix for the same collision was reverted; the counterexample was refuted
  2026-08-03 — 31 inline events across the suite and the QA fixtures, all at column 0)
- Do not drop `can_inline`'s `head_lane_ext.is_empty()` clause. It is load-bearing twice: it
  keeps the stash out of the rows the unpulled chain owns, **and** it is what keeps the
  reserved-and-free invariant below valid. Pinned by
  `stash_branches_right_when_the_head_lane_extends`
- **Every unpaired `pending_parents.insert`** (the map is a local of `assign_lanes` in
  `placement.rs`) — one that reserves a column without also
  occupying it in `active_lanes` — must either be the HEAD-chain pre-reservation or be
  excluded by a `can_inline` clause. Exactly two exist today, both at column 0: the
  `head_chain` pre-reservation and `head_lane_extension`, the second excluded by
  `head_lane_ext.is_empty()`. This is what makes every inline land at column 0, and it is why
  `!head_chain.contains(&p)` is not an exception to the clause above; the walk-through is in
  `docs/architecture/commit-graph.md` §"Phase 1". Landing a third insert without a matching
  exclusion re-opens it — re-derive before you land it, and record the result here
  (re-derived 2026-08-05, when `head_lane_extension` became the second)
- Never let the HEAD lane's upward extension take a stash. A stash hangs off its parent by
  first parent like any commit, and placing it in the lane would both steal column 0 from the
  branch's real continuation and bypass `can_inline` entirely. `head_lane_extension` filters
  the stash set out of **both** candidates — the tracked-upstream path and the revwalk-order
  continuation. Deleting either filter puts the stash into `pending_parents` at column 0,
  where it takes the lane in a fresh colour without `can_inline` ever running;
  `stash_inline_on_head_tip` is what catches it
- Any change on the dirty path must assert a **non-stash** branch's column *and* colour in
  `src-tauri/tests/test_graph.rs` — flipping clean↔dirty re-lays-out and re-colours unrelated
  branches. The churn that is already accepted is pinned by
  `dirtiness_relayouts_unrelated_branches` and
  `dirtiness_recolors_branches_below_the_stash_parent`
- A red graph golden, export or render snapshot is a suspected defect, never a stale
  artifact. Investigate before regenerating. The one legitimate door is
  `just graph-accept "<reason>"`, which records the reason in
  `docs/commit-graph-changelog.md` — never set `TRUNK_ACCEPT_GRAPH_GOLDENS` by hand, and
  never accept a change without the user's explicit direction. Regenerating destroys the only
  evidence these artifacts exist to produce. `just graph-capture` sits upstream of all three,
  rewriting the captured inputs in `src-tauri/tests/inputs/` that the goldens are computed
  from — it never writes a golden. A capture therefore turns the suite red with no code
  change, and that redness is a suspected defect like any other: investigate the input diff
  before accepting. Whether capture should demand a reason of its own is open; decide it the
  next time a capture turns the suite red, and record the ruling here. The same discipline is
  restated in `scripts/graph-accept.sh`, both `ACCEPT_HINT` strings
  (`src-tauri/tests/common/goldens.rs`, `src/__tests__/helpers/graph-render.ts`), and
  `docs/architecture/commit-graph.md` §"Golden corpus"; `scripts/graph-capture.sh`'s header
  states the upstream half only. When this bullet's substance changes, amend every
  restatement it touches in the same change. (Added 2026-08-07 at the user's direction, and
  every restatement amended in that same change — the red-golden half was already in the
  sites named above, but nothing stated the user-direction gate; the nearest policy was
  `docs/architecture/commit-graph.md`, which the "code wins" bullet above subordinates to the
  pipeline source)
- Tests: `just rust` (Rust — builds every graph suite: `src-tauri/tests/test_graph.rs` owns
  the repository-level assertions and pins the accepted dirtiness churn, `test_placement.rs`
  the pure lane algorithm, `test_graph_input.rs` page hydration, `test_graph_goldens.rs` the
  committed fixture corpus; plain `cargo test --lib` runs none of them, and `just` runs them
  the way CI does), `just front` (TypeScript)

## Reference

- `docs/architecture/commit-graph.md` — read before changing lane assignment, edge
  emission, or node rendering. Covers the pipeline stages, the per-commit phases, the file
  map, and the golden corpus (capture, red-golden discipline, `just graph-accept`)
- `docs/research/gitamine-graph-algorithm.md` — read only when reworking the placement algorithm
  itself. A comparison against gitamine's "straight branches", not a spec of current
  behaviour; its stash sections carry staleness notes. The docs sweep above still covers this
  file on every pipeline change
