---
status: resolved
trigger: "SVG lane lines in the commit graph are completely broken. Commits show dots but no lane lines connecting them."
created: 2026-03-08T00:00:00Z
updated: 2026-03-08T00:01:00Z
---

## Current Focus

hypothesis: CONFIRMED - Rust backend graph.rs never emits a Straight edge for a commit's own first-parent lane continuation
test: Manual algorithm trace for linear 3-commit chain
expecting: All commits would have zero edges in linear topology
next_action: Return diagnosis

## Symptoms

expected: Lane lines connecting commits vertically and with curves for forks/merges
actual: Only dots visible, no lane lines at all
errors: None reported (visual bug)
reproduction: Open any repository in the app
started: Unknown

## Eliminated

## Evidence

- timestamp: 2026-03-08T00:01:00Z
  checked: Manual trace of walk_commits algorithm for linear chain C2->C1->C0
  found: All three commits get ZERO edges. The algorithm at lines 52-65 only emits Straight edges for OTHER active lanes passing through (other_col != col). It never emits an edge for the commit's own lane. First-parent handling (lines 74-83) assigns lane but emits no edge.
  implication: In a single-lane linear history, every commit has empty edges array. No SVG lines are drawn.

- timestamp: 2026-03-08T00:01:00Z
  checked: First-parent edge emission at lines 74-83 of graph.rs
  found: The first parent (idx == 0) block only does lane assignment (active_lanes[col] = Some(parent_oid), pending_parents.insert). It never pushes a GraphEdge to the edges vector.
  implication: The vertical continuation line from any commit down to its first parent is never emitted. This is the MOST common edge type (every non-root commit should have one).

- timestamp: 2026-03-08T00:01:00Z
  checked: Secondary parent edge emission at lines 86-127 of graph.rs
  found: Secondary parents (idx > 0) DO correctly emit edges with proper EdgeType (MergeLeft/Right, ForkLeft/Right). Only secondary parents get edges.
  implication: In branched topologies, you'd see some merge/fork curves for secondary parents, but the primary lane continuation is still missing.

- timestamp: 2026-03-08T00:01:00Z
  checked: All Rust tests pass (5/5) including linear_topology
  found: Tests check that edges don't have unexpected types, and merge commits have merge edges. But linear_topology test does NOT assert that edges.len() > 0 for non-root commits. It only asserts no fork/merge edges exist.
  implication: Test coverage has a gap -- it doesn't verify that Straight edges ARE present, only that non-straight edges are absent.

- timestamp: 2026-03-08T00:01:00Z
  checked: Frontend LaneSvg.svelte rendering logic
  found: Rendering code is correct. It iterates commit.edges and draws lines/curves. If edges array is empty, nothing is drawn (just the dot). The bug is upstream -- edges array arrives empty from Rust.
  implication: Frontend is NOT the problem. Fix must be in graph.rs.

- timestamp: 2026-03-08T00:01:00Z
  checked: Type serialization chain (Rust types.rs -> TS types.ts)
  found: Types match perfectly. GraphEdge has same fields (from_column, to_column, edge_type, color_index). EdgeType variants match Rust enum names. Serde serialization uses default (PascalCase variant names) which matches TS string literals.
  implication: Serialization is NOT the problem. Even if edges were populated, they'd serialize correctly.

## Resolution

root_cause: graph.rs walk_commits() never emits a Straight edge for a commit's own first-parent lane continuation. Lines 74-83 handle the first parent by assigning it to the current column in active_lanes and pending_parents, but never push a GraphEdge to the edges vector. This means the vertical line connecting a commit to the row below (its first parent) is never generated. In linear histories this means ZERO edges per commit. In branched histories, only secondary parent edges (merge/fork curves) appear, but the primary lane line is still missing.
fix:
verification:
files_changed: []
