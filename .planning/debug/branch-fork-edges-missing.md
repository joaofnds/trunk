---
status: diagnosed
trigger: "Investigate why branch lane lines in the commit graph don't fork from the parent commit row"
created: 2026-03-08T00:00:00Z
updated: 2026-03-08T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — two interrelated bugs in walk_commits() lane assignment algorithm
test: completed — diagnostic test with branching repo topology
expecting: n/a — root cause confirmed
next_action: report diagnosis (find_root_cause_only mode)

## Symptoms

expected: Branch lanes (e.g. "test", "vk/76cb-review-c") fork from the parent commit row with curved ForkLeft/ForkRight connections, like git log --graph shows.
actual: Branch lanes appear as isolated vertical segments in their own column. Main lane (col 0) has correct Straight edges, but secondary lanes are visually disconnected — vertical lines with no fork edge connecting back to the divergence point.
errors: none (no crash, just wrong visual output)
reproduction: Open any repo with unmerged branches in the app; observe that branch lanes have straight vertical segments but no curved fork connections to the parent commit row.
started: Since initial implementation of walk_commits() graph algorithm.

## Eliminated

- hypothesis: IPC serialization drops fork edges
  evidence: TypeScript types (src/lib/types.ts) match Rust types exactly. EdgeType enum includes ForkLeft/ForkRight. Serde serialization is standard derive. No transformation layer that could drop edges.
  timestamp: 2026-03-08

- hypothesis: LaneSvg.svelte fails to render fork/merge edges
  evidence: The Svelte component correctly renders all non-Straight edges as Bezier curves (line 39-44). It iterates all edges and branches on edge_type. The rendering logic is correct for any data it receives.
  timestamp: 2026-03-08

- hypothesis: Fork edges are emitted but with wrong column values
  evidence: Diagnostic test shows fork edges ARE emitted in some cases (e.g. C3 emits ForkLeft(2->0)), but the column assignment itself is inverted — main gets col=2 while the branch tip gets col=0. So edges connect correct columns, but columns are assigned wrong.
  timestamp: 2026-03-08

## Evidence

- timestamp: 2026-03-08
  checked: walk_commits() algorithm trace with branching repo (main=C1->C2->C3, test diverges from C2, feature-x diverges from C1)
  found: |
    Revwalk order (TOPOLOGICAL|TIME): B1(test), F1(feature-x), C3(main), C2, C1
    Column assignments: B1=col0, F1=col1, C3=col2, C2=col0, C1=col1
    Edges emitted:
      Row 0 B1(col=0): Straight(0->0)
      Row 1 F1(col=1): Straight(0->0) passthrough, Straight(1->1)
      Row 2 C3(col=2): Straight(0->0) passthrough, Straight(1->1) passthrough, ForkLeft(2->0)
      Row 3 C2(col=0): Straight(1->1) passthrough, ForkRight(0->1)
      Row 4 C1(col=1): (no edges)
  implication: Branch tips steal column 0 because they appear first in the revwalk. Main (C3) gets pushed to col=2. The visual hierarchy is inverted — branches look like the trunk, and the trunk looks like a branch.

- timestamp: 2026-03-08
  checked: Compared with git log --graph output for identical topology
  found: |
    git log --graph shows:
      * F1 (feature-x)       <- col 2 or similar, fork line to col 0
      | * C3 (main)           <- col 0
      | | * B1 (test)         <- col 2, fork line at C2 row
      | |/
      | * C2                  <- col 0, with branch fork visual
      |/
      * C1                    <- col 0
    Main stays on col 0. Branches fork off to higher columns. Fork visuals appear at the divergence row.
  implication: The algorithm needs to prioritize the first-parent chain (main) for column 0, not whatever branch tip the revwalk visits first.

- timestamp: 2026-03-08
  checked: Algorithm lines 39-50 (column assignment for each commit)
  found: |
    When a commit is encountered, it checks pending_parents first (if a child already reserved a column for it).
    If not in pending_parents, it takes the first free lane or creates a new one.
    The FIRST branch tip encountered in the revwalk gets col=0 by default because no parents have been reserved yet and col=0 is the first free lane.
    There is NO priority for HEAD, main, or first-parent chains.
  implication: This is ROOT CAUSE #1 — column assignment is purely order-dependent with no branch priority heuristic.

- timestamp: 2026-03-08
  checked: Algorithm lines 72-148 (parent column assignment and edge emission)
  found: |
    When a branch tip (e.g. B1) is processed, it has ONE parent (C2). This is idx==0, so it enters the first-parent path (line 75). C2 is not yet in pending_parents, so it gets reserved at col=0 (same column as B1) with a Straight edge.
    There is NO fork edge emitted here because B1 and C2 share the same column — from the algorithm's perspective, this is a straight continuation, not a fork.
    The fork only becomes visible later when C3 (main) is processed and its parent C2 is already claimed at col=0, forcing C3 to col=2 and emitting ForkLeft(2->0).
    But this fork edge is on C3's row (the main branch), not on the branch's divergence row. The visual shows main forking from the branch, which is backwards.
  implication: This is ROOT CAUSE #2 — the algorithm never emits a fork edge at the actual divergence point (the shared ancestor row) because it only processes parent-child relationships downward from each commit. It has no concept of "this commit has multiple children that should visually fork here."

## Resolution

root_cause: |
  Two interrelated bugs in walk_commits() (src-tauri/src/git/graph.rs):

  **ROOT CAUSE #1: No branch-priority heuristic for column assignment.**
  The revwalk (TOPOLOGICAL|TIME) visits branch tips before shared ancestors. The first branch tip encountered claims column 0 (the visually primary lane). There is no logic to prioritize HEAD or the first-parent chain of the default branch. Result: side branches occupy column 0 and main gets pushed to higher columns, inverting the visual hierarchy.

  **ROOT CAUSE #2: No fork edges at divergence points.**
  The algorithm only emits edges going from a commit to its parents (downward). When two branch tips share a common ancestor, each branch tip emits a Straight edge to its parent (because it continues in the same column). The fork visual should appear at the ancestor's row showing child lanes splitting off, but the algorithm has no "child-to-parent" perspective — it only knows about parent assignment. The result is that branch lanes appear as isolated vertical segments with no curved fork connection to the main line.

  These two bugs compound: even when a ForkLeft/ForkRight IS emitted (e.g., when main's parent is already claimed by a branch), it appears on the wrong row (the main commit's row instead of the divergence point) and goes in the wrong direction (main forking toward the branch, instead of the branch forking from main).

fix: (not applied — diagnosis only)
verification: (not applied — diagnosis only)
files_changed: []
