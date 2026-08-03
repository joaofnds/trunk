---
paths:
  - "src-tauri/src/git/graph.rs"
  - "src-tauri/src/git/status.rs"
  - "src-tauri/src/git/types.rs"
  - "src/lib/types.ts"
  - "src/lib/active-lanes.ts"
  - "src/lib/overlay-paths.ts"
  - "src/lib/overlay-visible.ts"
  - "src/lib/graph-constants.ts"
  - "src/components/CommitGraph.svelte"
  - "src-tauri/tests/test_graph.rs"
---

# Commit Graph Rules

A pipeline of pure transformations: `graph.rs` assigns columns, colours and edges →
`active-lanes.ts` maps commits to overlay nodes and per-parent connections →
`overlay-paths.ts` emits SVG paths →
`overlay-visible.ts` culls off-screen paths, dots and pills → `CommitGraph.svelte` renders.

## Binding rules

This file is the binding source for the constraints below. `docs/architecture/overview.md`,
`docs/architecture/commit-graph.md`, and the staleness notes in
`docs/research/gitamine-graph-algorithm.md` all paraphrase these rules and cite `graph.rs`
line numbers. Treat every such passage as a mirror to re-check, and read it as explanation of
a rule stated here, never as a doc that "code wins" may overwrite.

- Never post-process the output of one stage to fix something an earlier stage should have
  done — the stages are interdependent and partial fixups desync. Fix the stage that owns the
  data; `docs/architecture/commit-graph.md` has the stage ownership
- Where a reference doc under `docs/` disagrees with the pipeline source — any file in this
  rule's `paths:` list — or with its tests, the code wins; correct the doc in the same change.
  The binding rules in *this* file do not yield that way: code that violates one is a bug in
  the code, not a rule to rewrite. Amend one only when the user directs it, and record the
  date and the cause inline, as the bullets below do
- After changing the pipeline, or a rule here, grep `docs/` **and the comments in the `paths:`
  files** for every symbol and mechanism the change touched, **including the ones it deleted**
  — a deleted mechanism is the one nothing points at any more, so nothing makes it surface.
  Correct every hit in the same change. Deleting the orphan-stash guard left three stale
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
  2026-08-03 — 31 inline events across the suite and the QA fixtures, all at column 0). Clause 4's
  `!head_chain.contains(&p)` is **not** an exception to this — the derivation is in
  `docs/architecture/commit-graph.md` §"Phase 1". Re-derive it if a new
  `pending_parents.insert` lands that does not also occupy the same column in `active_lanes`:
  it holds only while the HEAD-chain pre-reservation is the sole unpaired one
- Any change on the dirty path must assert a **non-stash** branch's column *and* colour in
  `src-tauri/tests/test_graph.rs` — flipping clean↔dirty re-lays-out and re-colours unrelated
  branches. The churn that is already accepted is pinned by
  `dirtiness_relayouts_unrelated_branches` and
  `dirtiness_recolors_branches_below_the_stash_parent`
- Tests: `just rust` (Rust — runs `src-tauri/tests/test_graph.rs`, which owns the graph assertions;
  plain `cargo test --lib` runs none of them, and `just` supplies the env scrub the suite
  needs), `just front` (TypeScript)

## Reference

- `docs/architecture/commit-graph.md` — read before changing lane assignment, edge
  emission, or node rendering. Covers the pipeline stages, the per-commit phases, and the
  file map
- `docs/research/gitamine-graph-algorithm.md` — read only when reworking the placement algorithm
  itself. A comparison against gitamine's "straight branches", not a spec of current
  behaviour; its stash sections carry staleness notes. The docs sweep above still covers this
  file on every pipeline change
