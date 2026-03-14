# Phase 21: Active Lanes Transformation - Research

**Researched:** 2026-03-13
**Domain:** TypeScript data transformation — git graph topology to grid coordinates
**Confidence:** HIGH

## Summary

Phase 21 implements a pure TypeScript function `buildGraphData()` that transforms Rust's `GraphCommit[]` output into `OverlayGraphData` containing `OverlayNode[]` and `OverlayEdge[]` with integer grid coordinates (x=swimlane column, y=row index). This is a data-only phase with zero UI dependencies — fully unit-testable in isolation.

The existing `computeGraphSvgData()` in `graph-svg-data.ts` is the conceptual predecessor. It processes the same input but produces per-row SVG path strings. Phase 21's `buildGraphData()` must handle all the same edge cases (WIP rows, stash entries, branch tips, merge/fork edges, sentinel OIDs) but output global grid coordinates instead of SVG paths. The critical new behavior is **edge coalescing** — merging consecutive same-lane straight segments into single `OverlayEdge` spans, reducing SVG DOM node count from O(commits × lanes) to O(lanes + merge_edges).

The types are already defined in Phase 20: `OverlayNode`, `OverlayEdge`, `OverlayGraphData` in `src/lib/types.ts`. The function takes `GraphCommit[]` (the `displayItems` array with WIP prepended) and `maxColumns`, and returns `OverlayGraphData`.

**Primary recommendation:** Implement `buildGraphData()` in `src/lib/active-lanes.ts` as a single pure function. Port all test scenarios from `graph-svg-data.test.ts` and add edge coalescing verification tests. The function is ~100-150 lines, the tests ~300-400 lines.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DATA-01 | TypeScript Active Lanes algorithm transforms `GraphCommit[]` into `GraphData` with `GraphNode[]` and `GraphEdge[]` containing integer grid coordinates (x=swimlane, y=row index) | Types already defined in `src/lib/types.ts` (OverlayNode, OverlayEdge, OverlayGraphData). Input format is `GraphCommit[]` from Rust backend. Grid coordinate system: x=column index, y=row index. All edge cases documented from existing `graph-svg-data.ts` implementation. |
| DATA-02 | Edge coalescing merges consecutive same-lane straight segments into single SVG path spans | Architecture doc specifies coalescing reduces O(commits × lanes) to O(lanes + merge_edges). Track active lanes per column, emit one OverlayEdge per continuous vertical run. Unit test must show reduced edge count vs naive 1-edge-per-row output. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ~5.6.2 | Implementation language | Project standard |
| vitest | ^4.1.0 | Test framework | Project standard, already configured in vite.config.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| N/A | — | No new dependencies needed | This is pure TS data transformation |

**Installation:**
```bash
# No new dependencies — all types and test infrastructure already exist
```

## Architecture Patterns

### Recommended Project Structure
```
src/lib/
├── active-lanes.ts        # NEW — buildGraphData() pure function
├── active-lanes.test.ts   # NEW — comprehensive unit tests
├── types.ts               # EXISTING — OverlayNode, OverlayEdge, OverlayGraphData
├── graph-constants.ts     # EXISTING — OVERLAY_* constants (not used by this phase directly)
├── graph-svg-data.ts      # EXISTING — old per-row pipeline (untouched, deleted in Phase 24)
└── graph-svg-data.test.ts # EXISTING — old tests (untouched, deleted in Phase 24)
```

### Pattern 1: Pure Function Transformation
**What:** `buildGraphData(commits: GraphCommit[], maxColumns: number): OverlayGraphData` — a stateless pure function with zero side effects.
**When to use:** Always. This function runs inside a `$derived.by()` block in CommitGraph.svelte (Phase 24 integration).
**Example:**
```typescript
// Source: Architecture research ARCHITECTURE.md Pattern 2
export function buildGraphData(
  commits: GraphCommit[],
  maxColumns: number,
): OverlayGraphData {
  const nodes: OverlayNode[] = [];
  const edges: OverlayEdge[] = [];

  // Track active vertical lanes for coalescing
  // Key: column index, Value: { startY, colorIndex, dashed }
  const activeLanes = new Map<number, { startY: number; colorIndex: number; dashed: boolean }>();

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];
    // ... process each commit, build nodes, track/flush lanes
  }

  // Flush any remaining active lanes
  flushAllLanes(activeLanes, commits.length - 1, edges);

  return { nodes, edges, maxColumns };
}
```

### Pattern 2: Edge Coalescing via Active Lane Tracking
**What:** Track active vertical lanes (same-column straight edges) and merge consecutive same-lane segments into single `OverlayEdge` spans. Only emit an edge when a lane terminates or changes properties (color, dashed).
**When to use:** For all `Straight` edge types where `from_column === to_column`.
**Example:**
```typescript
// For each row's straight edges:
for (const edge of straightEdges) {
  const existing = activeLanes.get(edge.from_column);
  if (existing && existing.colorIndex === edge.color_index && existing.dashed === edge.dashed) {
    // Continue existing lane — DON'T emit edge yet
    continue;
  }
  // Lane changed or new — flush old, start new
  if (existing) {
    edges.push({
      fromX: edge.from_column, fromY: existing.startY,
      toX: edge.from_column, toY: rowIndex,
      colorIndex: existing.colorIndex, dashed: existing.dashed,
    });
  }
  activeLanes.set(edge.from_column, {
    startY: rowIndex,
    colorIndex: edge.color_index,
    dashed: edge.dashed,
  });
}
```

### Pattern 3: WIP Sentinel Handling
**What:** WIP row (`oid === '__wip__'`) creates a node but no normal edges. It generates a dashed connector to the HEAD commit, spanning through intermediate rows.
**When to use:** When `commit.oid === '__wip__'`.
**Derived from:** Existing `computeGraphSvgData()` WIP handling (lines 89-119 of graph-svg-data.ts).
**Example:**
```typescript
if (commit.oid === '__wip__') {
  nodes.push({
    oid: '__wip__', x: commit.column, y: rowIndex,
    colorIndex: commit.color_index,
    isMerge: false, isBranchTip: false, isStash: false, isWip: true,
  });

  // Find HEAD commit row
  let headRow = -1;
  for (let r = rowIndex + 1; r < commits.length; r++) {
    if (commits[r].is_head) { headRow = r; break; }
  }
  if (headRow === -1) headRow = Math.min(rowIndex + 1, commits.length - 1);

  // Single dashed edge from WIP to HEAD
  edges.push({
    fromX: commit.column, fromY: rowIndex,
    toX: commit.column, toY: headRow,
    colorIndex: commit.color_index, dashed: true,
  });

  continue; // Skip normal edge processing
}
```

### Pattern 4: Connection Edges (Merge/Fork) — No Coalescing
**What:** Cross-lane edges (MergeLeft/Right, ForkLeft/Right) each become a single `OverlayEdge` with different from/to X coordinates. These are never coalesced.
**When to use:** For any edge where `from_column !== to_column`.
**Example:**
```typescript
for (const edge of connectionEdges) {
  // Merge edges connect FROM the commit's row TO the next row (going down)
  // Fork edges connect FROM the previous row TO the commit's row (going up)
  const isMerge = edge.edge_type === 'MergeLeft' || edge.edge_type === 'MergeRight';
  edges.push({
    fromX: edge.from_column,
    fromY: rowIndex,
    toX: edge.to_column,
    toY: isMerge ? rowIndex + 1 : rowIndex - 1,  // Phase 22 path builder handles exact curve
    colorIndex: edge.color_index,
    dashed: edge.dashed,
  });
}
```

**IMPORTANT NOTE on cross-lane edge coordinates:** The existing `computeGraphSvgData()` treats merge/fork edges as single-row events (rendered within one row using Manhattan routing). For the overlay, edges become global spans. The `OverlayEdge` `fromY/toY` represent the row endpoints — the Phase 22 bezier path builder will convert these to actual pixel coordinates with curve control points. The key design decision: keep coordinates at integer grid level and let the path builder handle sub-row positioning (dot center vs row top/bottom).

### Pattern 5: Branch Tip Start Position
**What:** Branch tip commits in their own column start their outgoing lane from the dot center, not the row top. This affects the `startY` of the coalesced lane — the lane begins at this row, not continuing from above.
**When to use:** When `commit.is_branch_tip && edge.from_column === commit.column`.
**Derived from:** `graph-svg-data.ts` line 138-139.

### Anti-Patterns to Avoid
- **Emitting per-row edges without coalescing:** Defeats the purpose. Would produce O(commits × lanes) edges instead of O(lanes + merge_edges).
- **Mixing pixel coordinates with grid coordinates:** This phase outputs integer grid coords only. Pixel conversion is Phase 22's job.
- **Modifying `OverlayEdge` type to include edge_type:** The type already has `fromX/fromY/toX/toY/colorIndex/dashed`. The path builder (Phase 22) determines curve shape from coordinate delta, not from an explicit type field.
- **Computing incoming rails separately:** The existing code has a separate "incoming rail" concept for non-branch-tip commits without a straight edge. With coalescing, the lane naturally terminates at the last row, so incoming rails are handled by the coalesced lane ending at the commit's dot.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Test framework | Custom test runner | vitest (already installed) | vitest 4.1.0 with config in vite.config.ts |
| Graph layout algorithm | Custom lane assignment | Rust backend's lane algorithm | Proven O(n) with all edge cases, ~5ms/10k commits |
| Type definitions | New type files | Existing `OverlayNode`, `OverlayEdge`, `OverlayGraphData` from `types.ts` | Phase 20 already defined them |

**Key insight:** This phase does NOT compute lane assignment, color assignment, or edge types. Rust does all of that. This phase merely re-maps Rust's per-row edge descriptors into global grid coordinate spans.

## Common Pitfalls

### Pitfall 1: Forgetting to Flush Active Lanes at End of Input
**What goes wrong:** The last few rows' straight edges never get emitted because no subsequent row triggers the flush.
**Why it happens:** Lane coalescing defers edge emission. The last active lane segment has no "next different" row to trigger output.
**How to avoid:** After the main loop, iterate `activeLanes` map and flush all remaining entries as edges.
**Warning signs:** Test with a simple 3-commit linear history — if the straight edge from row 0 to row 2 is missing, flushing is broken.

### Pitfall 2: WIP-to-HEAD Dashed Line Handling
**What goes wrong:** The dashed connector from WIP to HEAD gets coalesced with solid lane segments, losing its dashed property.
**Why it happens:** WIP row is at position 0, HEAD might be at position 2 with intermediate stash/branch rows. The lane in column 0 might have both dashed (WIP connector) and solid (pass-through) segments.
**How to avoid:** Handle WIP separately (with `continue`) BEFORE normal edge processing. The WIP dashed connector is emitted directly as a single edge, not tracked in `activeLanes`.
**Warning signs:** Missing or solid (not dashed) line between WIP dot and HEAD dot.

### Pitfall 3: Stash Dashed Flag Comes from Backend, Not Frontend Logic
**What goes wrong:** All stash edges render solid, or all edges on a stash row render dashed.
**Why it happens:** Incorrectly checking `commit.is_stash` to set dashed flag instead of reading `edge.dashed` from the backend.
**How to avoid:** Read `edge.dashed` directly from each `GraphEdge`. The Rust backend marks stash-lane edges as `dashed: true` and pass-through edges in other columns as `dashed: false`. Trust the backend data.
**Warning signs:** Test with a stash row that has pass-through edges in other columns — those must remain solid.

### Pitfall 4: Lane Coalescing Breaks at Property Changes
**What goes wrong:** Two adjacent segments with different colors or different dashed values get merged into one edge.
**Why it happens:** Only checking column equality for coalescing, not color_index and dashed flag.
**How to avoid:** Coalesce only when column AND colorIndex AND dashed all match the existing active lane entry. Flush and start a new lane entry on any property mismatch.
**Warning signs:** Solid and dashed segments in the same column rendering as all-solid or all-dashed.

### Pitfall 5: Connection Edge Y-Coordinate Semantics
**What goes wrong:** Cross-lane edges have wrong fromY/toY values, causing bezier curves to render between wrong rows.
**Why it happens:** Confusion about whether edges represent the source commit's row or the target commit's row.
**How to avoid:** For the overlay, a connection edge from commit at row R represents: the visual line going from one lane at row R to another lane at an adjacent row. The exact sub-row positioning (dot center, row top, row bottom) is Phase 22's concern. Keep fromY/toY as integer row indices only.
**Warning signs:** Bezier curves starting or ending at wrong rows in Phase 22 integration.

### Pitfall 6: Lanes Interrupted by Connection Edges
**What goes wrong:** A straight lane that also has a merge/fork edge at a row gets incorrectly broken into two segments.
**Why it happens:** Processing connection edges interferes with active lane tracking.
**How to avoid:** Straight edges and connection edges are independent. A row can have BOTH a straight edge continuing a lane AND a merge/fork edge to another column. The active lane tracking only cares about straight edges.
**Warning signs:** Gaps in vertical rail lines at rows where branches merge or fork.

## Code Examples

### Complete buildGraphData Skeleton
```typescript
// Source: Derived from graph-svg-data.ts + ARCHITECTURE.md Pattern 2
import type { GraphCommit, OverlayNode, OverlayEdge, OverlayGraphData } from './types.js';

interface ActiveLane {
  startY: number;
  colorIndex: number;
  dashed: boolean;
}

function flushLane(
  column: number,
  lane: ActiveLane,
  endY: number,
  edges: OverlayEdge[],
): void {
  if (endY > lane.startY) {
    edges.push({
      fromX: column,
      fromY: lane.startY,
      toX: column,
      toY: endY,
      colorIndex: lane.colorIndex,
      dashed: lane.dashed,
    });
  }
}

export function buildGraphData(
  commits: GraphCommit[],
  maxColumns: number,
): OverlayGraphData {
  const nodes: OverlayNode[] = [];
  const edges: OverlayEdge[] = [];
  const activeLanes = new Map<number, ActiveLane>();

  for (let y = 0; y < commits.length; y++) {
    const commit = commits[y];

    // --- WIP sentinel ---
    if (commit.oid === '__wip__') {
      nodes.push({
        oid: '__wip__', x: commit.column, y,
        colorIndex: commit.color_index,
        isMerge: false, isBranchTip: false, isStash: false, isWip: true,
      });
      // Find HEAD row, emit single dashed edge
      let headRow = -1;
      for (let r = y + 1; r < commits.length; r++) {
        if (commits[r].is_head) { headRow = r; break; }
      }
      if (headRow === -1) headRow = Math.min(y + 1, commits.length - 1);
      edges.push({
        fromX: commit.column, fromY: y,
        toX: commit.column, toY: headRow,
        colorIndex: commit.color_index, dashed: true,
      });
      continue;
    }

    // --- Node for this commit ---
    nodes.push({
      oid: commit.oid, x: commit.column, y,
      colorIndex: commit.color_index,
      isMerge: commit.is_merge,
      isBranchTip: commit.is_branch_tip,
      isStash: commit.is_stash,
      isWip: false,
    });

    // --- Separate straight vs connection edges ---
    for (const edge of commit.edges) {
      if (edge.from_column === edge.to_column) {
        // Straight edge — coalesce into active lane
        const col = edge.from_column;
        const existing = activeLanes.get(col);
        if (existing &&
            existing.colorIndex === edge.color_index &&
            existing.dashed === edge.dashed) {
          // Continue existing lane
          continue;
        }
        // Flush old, start new
        if (existing) {
          flushLane(col, existing, y, edges);
        }
        activeLanes.set(col, {
          startY: y,
          colorIndex: edge.color_index,
          dashed: edge.dashed,
        });
      } else {
        // Connection edge — emit directly
        edges.push({
          fromX: edge.from_column,
          fromY: y,
          toX: edge.to_column,
          toY: y, // Same row — path builder uses edge_type semantics
          colorIndex: edge.color_index,
          dashed: edge.dashed,
        });
      }
    }

    // If this column has no straight edge continuing, flush its lane
    const columnsWithStraight = new Set(
      commit.edges
        .filter(e => e.from_column === e.to_column)
        .map(e => e.from_column)
    );
    for (const [col, lane] of activeLanes) {
      if (!columnsWithStraight.has(col)) {
        flushLane(col, lane, y, edges);
        activeLanes.delete(col);
      }
    }
  }

  // Flush remaining active lanes
  for (const [col, lane] of activeLanes) {
    flushLane(col, lane, commits.length - 1, edges);
  }

  return { nodes, edges, maxColumns };
}
```

### Test Factory Pattern (Match Existing Convention)
```typescript
// Source: graph-svg-data.test.ts pattern
import type { GraphCommit, GraphEdge } from './types.js';

function makeCommit(overrides: Partial<GraphCommit> & { oid: string }): GraphCommit {
  return {
    oid: overrides.oid,
    short_oid: overrides.oid.slice(0, 7),
    summary: 'test commit',
    body: null,
    author_name: 'Test',
    author_email: 'test@test.com',
    author_timestamp: 0,
    parent_oids: overrides.parent_oids ?? [],
    column: overrides.column ?? 0,
    color_index: overrides.color_index ?? 0,
    edges: overrides.edges ?? [],
    refs: overrides.refs ?? [],
    is_head: overrides.is_head ?? false,
    is_merge: overrides.is_merge ?? false,
    is_branch_tip: overrides.is_branch_tip ?? false,
    is_stash: overrides.is_stash ?? false,
  };
}

function makeEdge(overrides: Partial<GraphEdge> & { edge_type: GraphEdge['edge_type'] }): GraphEdge {
  return {
    from_column: overrides.from_column ?? 0,
    to_column: overrides.to_column ?? 0,
    edge_type: overrides.edge_type,
    color_index: overrides.color_index ?? 0,
    dashed: overrides.dashed ?? false,
  };
}
```

### Edge Coalescing Test Pattern
```typescript
it('coalesces consecutive same-lane straight segments', () => {
  // 3 commits, all in column 0, same color — should produce 1 edge, not 3
  const commits = [
    makeCommit({ oid: 'a', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
    makeCommit({ oid: 'b', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
    makeCommit({ oid: 'c', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
  ];
  const result = buildGraphData(commits, 1);

  const straightEdges = result.edges.filter(e => e.fromX === e.toX);
  expect(straightEdges).toHaveLength(1);
  expect(straightEdges[0]).toEqual({
    fromX: 0, fromY: 0, toX: 0, toY: 2,
    colorIndex: 0, dashed: false,
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-row SVG path strings (`computeGraphSvgData`) | Global grid coordinates (`buildGraphData`) | v0.5 (Phase 21) | Enables continuous bezier curves, eliminates row-boundary seams |
| Manhattan routing (H/V/A SVG commands) | Integer grid coords → bezier (Phase 22) | v0.5 | Smoother, professional appearance |
| O(commits × lanes) edge segments | O(lanes + merge_edges) via coalescing | v0.5 | Critical for SVG DOM performance at 10k+ commits |

**Deprecated/outdated:**
- `computeGraphSvgData()` in `graph-svg-data.ts`: Will be replaced by `buildGraphData()` + Phase 22 path builder. Deleted in Phase 24.

## Open Questions

1. **Connection edge fromY/toY semantics for cross-lane edges**
   - What we know: Rust provides `from_column`/`to_column` and `edge_type` (MergeLeft/Right, ForkLeft/Right) per row. The existing code renders these as single-row paths with Manhattan routing.
   - What's unclear: Should OverlayEdge for a cross-lane edge have `fromY === toY` (same row, path builder interprets direction from coordinates) or `fromY !== toY` (explicit from/to rows)?
   - Recommendation: Use `fromY === toY === rowIndex` for connection edges. The path builder (Phase 22) can determine curve direction from `fromX` vs `toX` and the edge_type context is implicit. This matches the Rust data model where each edge belongs to one row. The path builder converts to pixel coordinates with appropriate curve control points.

2. **Whether `OverlayEdge` needs an `edgeType` field**
   - What we know: The defined `OverlayEdge` type has only `fromX/fromY/toX/toY/colorIndex/dashed` — no edge type.
   - What's unclear: The Phase 22 path builder needs to know if an edge is straight (vertical line), merge (curve going down), or fork (curve going up) to generate correct bezier control points.
   - Recommendation: If `fromX === toX`, it's a straight vertical rail. If `fromX !== toX`, it's a cross-lane edge. The direction can be inferred from whether `fromY < toY` (going down, merge-like) or `fromY > toY` (going up, fork-like). No additional type field needed with current `OverlayEdge` definition. However, if Phase 22 research finds this insufficient, the type can be extended at that point.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | `vite.config.ts` (test section at line 24-27) |
| Quick run command | `npx vitest run src/lib/active-lanes.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | buildGraphData accepts GraphCommit[] and returns OverlayGraphData with OverlayNode[] and OverlayEdge[] | unit | `npx vitest run src/lib/active-lanes.test.ts -t "returns OverlayGraphData" -x` | ❌ Wave 0 |
| DATA-01 | Nodes have correct x=swimlane, y=row coordinates | unit | `npx vitest run src/lib/active-lanes.test.ts -t "node coordinates" -x` | ❌ Wave 0 |
| DATA-01 | Connection edges (merge/fork) are correctly mapped | unit | `npx vitest run src/lib/active-lanes.test.ts -t "connection edge" -x` | ❌ Wave 0 |
| DATA-01 | WIP row handled (node created, dashed edge to HEAD) | unit | `npx vitest run src/lib/active-lanes.test.ts -t "WIP" -x` | ❌ Wave 0 |
| DATA-01 | Stash rows handled (dashed flag from backend preserved) | unit | `npx vitest run src/lib/active-lanes.test.ts -t "stash" -x` | ❌ Wave 0 |
| DATA-02 | Edge coalescing merges same-lane straight segments | unit | `npx vitest run src/lib/active-lanes.test.ts -t "coalesce" -x` | ❌ Wave 0 |
| DATA-02 | Coalescing breaks at color/dashed boundary | unit | `npx vitest run src/lib/active-lanes.test.ts -t "property change" -x` | ❌ Wave 0 |
| SC-1 | buildGraphData returns correct structure | unit | `npx vitest run src/lib/active-lanes.test.ts -t "returns" -x` | ❌ Wave 0 |
| SC-2 | Edge coalescing verified (reduced count) | unit | `npx vitest run src/lib/active-lanes.test.ts -t "reduced edge count" -x` | ❌ Wave 0 |
| SC-3 | WIP and stash sentinel rows handled | unit | `npx vitest run src/lib/active-lanes.test.ts -t "sentinel" -x` | ❌ Wave 0 |
| SC-4 | Linear, branch, merge, octopus, WIP, stash, empty | unit | `npx vitest run src/lib/active-lanes.test.ts -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/active-lanes.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/active-lanes.ts` — implementation file
- [ ] `src/lib/active-lanes.test.ts` — covers DATA-01, DATA-02, all success criteria
- Framework install: Not needed — vitest already configured

## Sources

### Primary (HIGH confidence)
- `src/lib/graph-svg-data.ts` — existing transformation logic (178 lines), reference implementation for all edge cases
- `src/lib/graph-svg-data.test.ts` — existing test suite (574 lines, 37 tests), test scenarios to port
- `src/lib/types.ts` — OverlayNode, OverlayEdge, OverlayGraphData type definitions (lines 136-160)
- `src/lib/graph-constants.ts` — OVERLAY_* constants (lines 8-14)
- `src/components/CommitGraph.svelte` — displayItems construction, WIP row creation (lines 254-268)
- `.planning/research/ARCHITECTURE.md` — Pattern 2: Active Lanes Transformation, edge coalescing spec

### Secondary (MEDIUM confidence)
- `.planning/research/SUMMARY.md` — Phase 2 deliverables description, build order rationale

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, existing types/test infrastructure
- Architecture: HIGH — clear reference implementation in graph-svg-data.ts, well-specified in ARCHITECTURE.md
- Pitfalls: HIGH — all edge cases documented from existing implementation and its 37 passing tests

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable — pure data transformation, no external dependencies)
