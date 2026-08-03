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
---

# Commit Graph Rules

A pipeline of pure transformations: `graph.rs` assigns columns, colours and edges →
`active-lanes.ts` maps commits to overlay nodes and per-parent connections →
`overlay-paths.ts` emits SVG paths →
`overlay-visible.ts` culls off-screen paths, dots and pills → `CommitGraph.svelte` renders.

## Binding rules

This file is the binding source for the constraints below. `docs/architecture/commit-graph.md`,
`docs/architecture/overview.md`, and the staleness notes in
`docs/research/gitamine-graph-algorithm.md` point here instead of restating them. When you
change a rule here, grep the docs tree for the symbol it names — `can_inline`,
`worktree_dirty`, the marker shapes — because copies drift where you don't expect them.

- Never post-process the output of one stage to fix something an earlier stage should have
  done — the stages are interdependent and partial fixups desync
- Where a reference doc disagrees with the pipeline source — any file in this rule's `paths:`
  list — or with its tests, the code wins; correct the doc in the same change
- A stash's graph marker is a dashed hollow **square** (`<rect>`) with dashed edges. Hollow
  alone does not identify a stash: WIP is a dashed hollow **circle**, a merge is a
  solid-stroke hollow circle
- Stash *lane assignment* deliberately depends on worktree state: `can_inline` places a stash
  inline at its parent's column only when the worktree is clean, and branches it right
  otherwise. The frontend prepends the WIP row at the head-chain column whenever
  `wipCount > 0`, and an inline stash can only ever land in that same column. Do not drop the
  `!worktree_dirty` clause (amended 2026-08-02, after a TypeScript-only fix for the same
  collision was reverted)
- Any change on the dirty path must assert a **non-stash** branch's column *and* colour in
  `src-tauri/tests/test_graph.rs` — flipping clean↔dirty re-lays-out and re-colours unrelated
  branches
- Tests: `just rust` (Rust — runs `src-tauri/tests/test_graph.rs`, which owns the graph assertions;
  plain `cargo test --lib` runs none of them, and `just` supplies the env scrub the suite
  needs), `just front` (TypeScript). `just check` before commit

## Reference

- `docs/architecture/commit-graph.md` — read before changing lane assignment, edge
  emission, or node rendering. Covers the pipeline stages, the per-commit phases, and the
  file map
- `docs/research/gitamine-graph-algorithm.md` — read only when reworking the placement algorithm
  itself. A comparison against gitamine's "straight branches", not a spec of current
  behaviour; its stash sections carry staleness notes
