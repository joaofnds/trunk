---
paths:
  - "src-tauri/src/git/graph.rs"
  - "src/lib/active-lanes.ts"
  - "src/lib/overlay-paths.ts"
  - "src/lib/graph-constants.ts"
  - "src/components/CommitGraph.svelte"
  - "src/lib/graph-svg-data.ts"
---

# Commit Graph Rules

Before making changes to the graph pipeline, read these references:

- @.planning/COMMIT-GRAPH-ARCHITECTURE.md — full architecture of Trunk's 4-layer graph pipeline (Rust → active-lanes → overlay-paths → Svelte)
- @.planning/GITAMINE-ALGORITHM-STUDY.md — study of the "straight branches" algorithm from gitamine, with a detailed comparison against Trunk's algorithm

Key principles:

- Never post-process the output of one layer to fix something the prior layer should have done — the layers are interdependent
- Where a reference doc disagrees with `src-tauri/src/git/graph.rs` or `src-tauri/tests/test_graph.rs`, the code wins — correct the doc in the same change
- Stash *rendering* differs from a regular commit only in being a dashed hollow **square** (`<rect>`) with dashed edges. Hollow alone does not identify a stash — WIP and merge nodes are hollow circles
- Stash *lane assignment* deliberately depends on worktree state: `can_inline` places a stash inline at its parent's column only when the worktree is clean, and branches it right otherwise. The frontend prepends the WIP row at the head-chain column whenever `wipCount > 0`, and an inline stash can only ever land in that same column. Do not drop the `!worktree_dirty` clause (amended 2026-08-02, after a TypeScript-only fix for the same collision was reverted)
- Any change on the dirty path must assert a **non-stash** branch's column *and* colour in `tests/test_graph.rs` — flipping clean↔dirty re-lays-out and re-colours unrelated branches
- Test commands: `just rust` (Rust — runs `tests/test_graph.rs`, which owns the graph assertions; plain `cargo test --lib` runs none of them, and `just` supplies the env scrub the suite needs), `just front` (TypeScript). `just check` before commit
