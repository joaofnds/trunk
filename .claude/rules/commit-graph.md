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

This file is the binding source for the constraints below. `docs/architecture/commit-graph.md`
and `docs/architecture/overview.md` point here instead of restating them. The staleness notes
in `docs/research/gitamine-graph-algorithm.md` do **not** — they paraphrase the stash
placement rule and cite `graph.rs` line numbers, so treat every one as a mirror to re-check.

- Never post-process the output of one stage to fix something an earlier stage should have
  done — the stages are interdependent and partial fixups desync. Fix the stage that owns the
  data; `docs/architecture/commit-graph.md` has the stage ownership
- Where a reference doc disagrees with the pipeline source — any file in this rule's `paths:`
  list — or with its tests, the code wins; correct the doc in the same change
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
  `wipCount > 0`, and an inline stash lands in that same column. Clause 4's
  `!head_chain.contains(&p)` reads like an exception to that and is not one: inlining also
  needs the parent's column *reserved in `pending_parents` and still free in `active_lanes`*,
  and the two are set together everywhere except the HEAD-chain pre-reservation — so the only
  reserved-and-free column is column 0, which clause 4 then narrows to the HEAD tip. Do not
  drop the `!worktree_dirty` clause (amended 2026-08-02, after a TypeScript-only fix for the
  same collision was reverted; the off-chain counterexample was probed and refuted
  2026-08-03 — 31 inline events across the suite and the QA fixtures, all at column 0).
  Re-derive that reasoning if a new `pending_parents.insert` lands that does not also occupy
  the same column in `active_lanes` — it holds only while the HEAD-chain pre-reservation is
  the sole unpaired one
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
