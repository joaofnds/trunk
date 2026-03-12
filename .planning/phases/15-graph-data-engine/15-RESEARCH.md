# Phase 15: Graph Data Engine - Research

**Researched:** 2026-03-12
**Domain:** SVG path generation from commit graph data (TypeScript, Svelte 5 reactivity)
**Confidence:** HIGH

## Summary

Phase 15 transforms the commit graph from per-row SVG rendering to a data engine that pre-computes continuous SVG `<path>` d-strings per commit-to-commit edge. The current `LaneSvg.svelte` component generates SVG elements inline during rendering -- each row independently builds its own line segments and path fragments. The new approach computes all path data upfront in a reactive `$derived.by()` block, producing a `Map` of edge keys to complete SVG path d-strings that span the full graph height.

The Rust backend (`graph.rs`) already provides all necessary data: `GraphCommit` with `column`, `color_index`, `edges` (containing `from_column`, `to_column`, `edge_type`, `color_index`), and `parent_oids`. No Rust changes are needed. The existing `buildEdgePath()` function in `LaneSvg.svelte` contains the Manhattan routing logic (horizontal + arc + vertical) that must be replicated in the new path generator to produce identical visual output.

**Primary recommendation:** Create a new `src/lib/graph-svg-data.ts` module with a pure function that takes `GraphCommit[]` and `maxColumns` and returns a `Map<string, SvgPathData>` containing one continuous SVG path d-string per parent-child edge. Use `$derived.by()` in `CommitGraph.svelte` to reactively recompute only when `commits` or `maxColumns` change.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Path generation in TypeScript, not Rust -- Rust already returns all needed data (GraphCommit with edges, columns, color_index)
- Zero new dependencies -- architecture change only
- ViewBox-clipped per-row SVGs (not overlay/full-height SVG)
- Each row clips into the continuous paths using viewBox offset

### Claude's Discretion
- **Edge granularity** -- whether to generate one path per parent-child link or one continuous path per lane segment. Choose based on what simplifies Phase 16 rendering while keeping path count manageable.
- **Module boundary** -- where GraphSvgData lives (new module vs extending existing). Should integrate cleanly with the CommitGraph -> CommitRow -> LaneSvg pipeline without breaking the current flow.
- **Synthetic row scope** -- whether WIP/stash sentinel rows are included in Phase 15 path computation or deferred entirely to Phase 17. Current LaneSvg.svelte handles them as special cases with sentinel OIDs (`__wip__`, `__stash_N__`).
- Reactivity strategy -- `$derived.by()` pattern per existing codebase conventions
- Data structure shape for GraphSvgData
- Manhattan routing implementation details (arc radius, segment ordering)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GRAPH-01 | GraphSvgData computes one SVG `<path>` per commit-to-commit edge (parent links and merge/fork edges), each rendered as a single unbroken path with Manhattan routing where needed | Path generation algorithm design, Manhattan routing analysis, data structure specification, reactivity pattern |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | ^5.0.0 | Component framework + reactivity | Already in project, `$derived.by()` for reactive path computation |
| TypeScript | ~5.6.2 | Type-safe path generation logic | Already in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | -- | -- | Zero new dependencies per locked decision |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Pure TS module | Rust-side path gen | Locked decision: TS chosen because Rust already returns all needed data; avoid IPC overhead for string-heavy operation |

## Architecture Patterns

### Recommended Project Structure
```
src/
├── lib/
│   ├── graph-svg-data.ts       # NEW: pure path generation functions
│   ├── graph-constants.ts      # EXISTING: LANE_WIDTH, ROW_HEIGHT, etc.
│   └── types.ts                # EXISTING: add SvgPathData type
├── components/
│   ├── CommitGraph.svelte      # MODIFY: add $derived.by() for path computation
│   ├── CommitRow.svelte        # NO CHANGE in Phase 15
│   └── LaneSvg.svelte          # NO CHANGE in Phase 15 (replaced in Phase 16)
```

### Pattern 1: One Path Per Parent-Child Link (RECOMMENDED)

**What:** Generate one SVG `<path>` d-string for each parent-child relationship. Each path traces from the child commit's row position to the parent commit's row position as a continuous line.

**When to use:** Always -- this is the core architecture.

**Why over lane-segment approach:** A lane segment groups multiple commit-to-commit connections that happen to share a column into one long path. While this reduces path count, it creates complexity: paths must be split/joined when branches merge or fork, making the algorithm harder and harder to debug. One path per parent-child link is simpler, maps directly to git's data model, and produces a manageable path count (one per parent pointer, so roughly 1.1x the commit count for linear history, 2x for heavily branching repos).

**Data flow:**
```
GraphCommit[] (from Rust IPC)
  → computeGraphSvgData(commits, maxColumns)
    → Map<string, SvgPathData>
      key: "{childOid}:{parentOid}"
      value: { d: string, colorIndex: number, isMerge: boolean }
```

### Pattern 2: Manhattan Routing for Non-Straight Edges

**What:** The current `buildEdgePath()` in `LaneSvg.svelte` uses Manhattan routing: horizontal segment + quarter-circle arc + vertical segment. The new path generator must produce equivalent path strings but spanning full row heights rather than single-row fragments.

**Current single-row routing (from LaneSvg.svelte):**
```typescript
// MergeLeft/MergeRight: dot → horizontal → arc down → vertical to row bottom
`M ${x1} ${cy} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${cy + r} V ${rowHeight}`

// ForkLeft/ForkRight: dot → horizontal → arc up → vertical to row top
`M ${x1} ${cy} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${cy - r} V ${0}`
```

**New continuous routing (spans multiple rows):**
For a child at row `i` connecting to parent at row `j` (j > i because parents appear later in topological order):
- **Straight edge (same column):** `M ${cx} ${childY} V ${parentY}` -- single vertical line
- **Column-changing edge:** Child row has a connection edge (Merge/Fork type). The path goes: vertical from child dot to the connection row's midpoint, then horizontal + arc to target column, then vertical down to parent dot.

### Pattern 3: Absolute Y Coordinates

**What:** All path coordinates use absolute Y positions based on row index: `rowIndex * ROW_HEIGHT`. This makes viewBox clipping in Phase 16 trivial -- each row renders a band with `viewBox="0 ${rowIndex * ROW_HEIGHT} ${width} ${ROW_HEIGHT}"`.

**Example:**
```typescript
const childY = childRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;  // center of child row
const parentY = parentRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2; // center of parent row
```

### Pattern 4: Reactive Computation with $derived.by()

**What:** Path data recomputes only when input data changes, not on scroll. Use `$derived.by()` in `CommitGraph.svelte` (the component that owns `commits` state).

**Example:**
```typescript
// In CommitGraph.svelte
import { computeGraphSvgData } from '../lib/graph-svg-data.js';

const graphSvgData = $derived.by(() => {
  return computeGraphSvgData(displayItems, maxColumns);
});
```

The `displayItems` already includes WIP row when present. The pure function handles the computation; the reactive wrapper ensures it only runs when dependencies change.

### Anti-Patterns to Avoid
- **Computing paths per-row during render:** This is what the current LaneSvg does. The whole point of Phase 15 is to move path computation OUT of the render loop.
- **Storing paths in a flat array indexed by row:** Paths span multiple rows. The key should be the edge identity (child:parent), not the row.
- **Using $effect for path computation:** `$effect` runs after rendering and causes an extra frame. `$derived.by()` computes synchronously before render.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SVG path syntax | Custom string builder class | Template literal concatenation | SVG path d-strings are simple concatenation; a builder adds overhead with no benefit |
| Reactive caching | Custom memoization wrapper | `$derived.by()` | Svelte 5's built-in reactivity already handles equality-based re-execution |
| Row index lookup | Linear scan per edge | `Map<string, number>` oid-to-index built once | O(1) lookup needed for each edge's parent row position |

**Key insight:** This phase is pure data transformation -- `GraphCommit[] → Map<string, SvgPathData>`. No libraries needed; it is array iteration + string concatenation + coordinate math.

## Common Pitfalls

### Pitfall 1: Parent Not in Loaded Commits
**What goes wrong:** A commit's `parent_oids` references a commit that hasn't been loaded yet (pagination -- only `BATCH=200` commits loaded at a time). The path generator tries to find the parent's row index and gets `undefined`.
**Why it happens:** Virtual scrolling loads commits in batches. The last commits in a batch may have parents not yet loaded.
**How to avoid:** When a parent OID is not found in the oid-to-index map, generate a path that extends to the bottom of the visible range (last loaded row). The path will be extended when more commits load. This is identical to current behavior where straight edges just go to `rowHeight` (bottom of current row).
**Warning signs:** Missing paths at the bottom of the commit list; errors in console about undefined row indices.

### Pitfall 2: WIP and Stash Sentinel Rows
**What goes wrong:** Sentinel OIDs like `__wip__` and `__stash_N__` are synthetic rows not returned by Rust. They have special rendering (dashed lines, hollow circles). Including them in the general path computation produces incorrect paths.
**Why it happens:** `displayItems` in CommitGraph.svelte prepends a WIP row when `wipCount > 0`. These have hardcoded edge data.
**How to avoid:** **Recommendation: Defer synthetic rows to Phase 17** (SYNTH-01, SYNTH-02). In Phase 15, filter out sentinel OIDs before path computation. The existing LaneSvg.svelte continues rendering WIP/stash rows with the old per-row approach until Phase 17 migrates them.
**Warning signs:** Dashed connectors appearing as solid paths; WIP row not rendering correctly.

### Pitfall 3: Off-by-One in Row Index Calculation
**What goes wrong:** Paths are offset by one row height because the WIP row (when present) shifts all commit indices by 1.
**Why it happens:** `displayItems` may include a WIP row at index 0, but the Rust-provided commits start at index 0 (or 1 if WIP present). The path generator must use the `displayItems` index, not the commits array index.
**How to avoid:** Build the oid-to-index map from `displayItems` (which includes WIP if present), or explicitly account for the offset.
**Warning signs:** All paths shifted up/down by exactly ROW_HEIGHT pixels.

### Pitfall 4: Arc Direction for Left vs Right Movement
**What goes wrong:** Arc sweep flags are wrong, producing paths that curve the wrong way.
**Why it happens:** SVG arc sweep direction depends on whether the path moves left or right. The current `buildEdgePath` carefully sets `sweep` based on `goingRight`.
**How to avoid:** Copy the sweep logic exactly from current `buildEdgePath`. For MergeLeft/MergeRight: `sweep = goingRight ? 1 : 0`. For ForkLeft/ForkRight: `sweep = goingRight ? 0 : 1`.
**Warning signs:** Visual artifacts where paths cross lanes incorrectly.

### Pitfall 5: Reactivity Triggering on Every Scroll
**What goes wrong:** Path computation runs on every scroll event, defeating the purpose.
**Why it happens:** If the `$derived.by()` closure captures a value that changes on scroll (like scroll position or visible range).
**How to avoid:** The `$derived.by()` must ONLY depend on `commits` (or `displayItems`) and `maxColumns`. No scroll-related state. Svelte 5's fine-grained reactivity handles this correctly as long as the closure doesn't read scroll state.
**Warning signs:** Jank during scrolling; profiler showing path computation in scroll handler.

## Code Examples

### Core Path Generation Function
```typescript
// src/lib/graph-svg-data.ts
import type { GraphCommit, GraphEdge, EdgeType } from './types.js';
import { LANE_WIDTH, ROW_HEIGHT } from './graph-constants.js';

export interface SvgPathData {
  d: string;          // SVG path d-string
  colorIndex: number; // lane color index (mod 8)
}

/**
 * Compute one SVG path d-string per commit-to-commit edge.
 * Returns a Map keyed by "childOid:parentOid" (or "childOid:straight:col" for pass-through rails).
 */
export function computeGraphSvgData(
  commits: GraphCommit[],
  _maxColumns: number,
): Map<string, SvgPathData> {
  const paths = new Map<string, SvgPathData>();

  // Build OID → row index lookup
  const oidToRow = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    oidToRow.set(commits[i].oid, i);
  }

  const cx = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
  const cy = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const cornerRadius = LANE_WIDTH / 2;

  for (let rowIdx = 0; rowIdx < commits.length; rowIdx++) {
    const commit = commits[rowIdx];

    // Skip synthetic rows (handled by Phase 17)
    if (commit.oid.startsWith('__')) continue;

    for (const edge of commit.edges) {
      if (edge.edge_type === 'Straight') {
        // Straight edge: vertical rail from this row to next row in same column
        // These connect adjacent rows to form continuous vertical lanes
        const x = cx(edge.from_column);
        const y1 = commit.is_branch_tip && edge.from_column === commit.column
          ? cy(rowIdx)     // branch tip: start from dot center
          : rowIdx * ROW_HEIGHT;  // otherwise: start from row top
        const y2 = (rowIdx + 1) * ROW_HEIGHT; // extend to bottom of row

        const key = `${commit.oid}:straight:${edge.from_column}`;
        paths.set(key, {
          d: `M ${x} ${y1} V ${y2}`,
          colorIndex: edge.color_index,
        });
      } else {
        // Connection edge (Merge/Fork): horizontal + arc + vertical
        const x1 = cx(edge.from_column);
        const x2 = cx(edge.to_column);
        const midY = cy(rowIdx);
        const r = cornerRadius;
        const goingRight = edge.to_column > edge.from_column;
        const hTarget = goingRight ? x2 - r : x2 + r;

        let d: string;
        switch (edge.edge_type as EdgeType) {
          case 'MergeLeft':
          case 'MergeRight': {
            const sweep = goingRight ? 1 : 0;
            d = `M ${x1} ${midY} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${midY + r} V ${(rowIdx + 1) * ROW_HEIGHT}`;
            break;
          }
          case 'ForkLeft':
          case 'ForkRight': {
            const sweep = goingRight ? 0 : 1;
            d = `M ${x1} ${midY} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${midY - r} V ${rowIdx * ROW_HEIGHT}`;
            break;
          }
          default:
            continue;
        }

        const key = `${commit.oid}:${edge.edge_type}:${edge.from_column}:${edge.to_column}`;
        paths.set(key, { d, colorIndex: edge.color_index });
      }
    }

    // Incoming rail for non-branch-tip commits without a straight edge in their column
    const hasStraightInColumn = commit.edges.some(
      (e) => e.edge_type === 'Straight' && e.from_column === commit.column
    );
    if (!commit.is_branch_tip && !commit.oid.startsWith('__') && !hasStraightInColumn) {
      const x = cx(commit.column);
      const key = `${commit.oid}:incoming-rail`;
      paths.set(key, {
        d: `M ${x} ${rowIdx * ROW_HEIGHT} V ${cy(rowIdx)}`,
        colorIndex: commit.color_index,
      });
    }
  }

  return paths;
}
```

### Reactive Integration in CommitGraph.svelte
```typescript
// In CommitGraph.svelte <script> block
import { computeGraphSvgData } from '../lib/graph-svg-data.js';

// Recomputes only when displayItems or maxColumns changes -- NOT on scroll
const graphSvgData = $derived.by(() => {
  return computeGraphSvgData(displayItems, maxColumns);
});
```

### Edge Key Format
```
// Straight rail:        "{oid}:straight:{column}"
// Connection edge:      "{oid}:{edgeType}:{fromCol}:{toCol}"
// Incoming rail:        "{oid}:incoming-rail"
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-row SVG with inline path computation | Pre-computed continuous paths with viewBox clipping | This phase (v0.4) | Eliminates row-boundary seam bugs; enables future hover-highlight per branch |
| `buildEdgePath()` in Svelte component | Pure TS function in `graph-svg-data.ts` | This phase | Testable without component rendering; single source of path truth |

## Open Questions

1. **Continuous path stitching across pagination boundaries**
   - What we know: Commits load in batches of 200. A straight rail at the end of batch 1 should connect to the start of batch 2.
   - What's unclear: Should the path generator handle this by extending the last path, or should the caller merge paths when new batches load?
   - Recommendation: Generate paths per batch independently. Paths extending to the bottom of the current batch will visually connect to paths starting at the top of the next batch because they share the same X coordinate and the Y coordinates are contiguous (row N ends at `(N+1)*ROW_HEIGHT`, row N+1 starts at `(N+1)*ROW_HEIGHT`). No stitching needed.

2. **Map vs Array for path storage**
   - What we know: Phase 16 needs to quickly find all paths that intersect a given row for viewBox clipping.
   - What's unclear: Whether a `Map<string, SvgPathData>` is the right structure or if paths should also be indexed by row range.
   - Recommendation: Start with Map keyed by edge identity. Phase 16 can build a secondary index (row -> path keys) if needed. Keep Phase 15 simple.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (not yet installed) |
| Config file | none -- see Wave 0 |
| Quick run command | `npx vitest run src/lib/graph-svg-data.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GRAPH-01a | One path per straight edge per commit | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "straight"` | No -- Wave 0 |
| GRAPH-01b | One path per merge/fork connection edge | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "merge"` | No -- Wave 0 |
| GRAPH-01c | Manhattan routing preserved (H + A + V segments) | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "manhattan"` | No -- Wave 0 |
| GRAPH-01d | Incoming rail for non-branch-tip without straight edge | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "incoming"` | No -- Wave 0 |
| GRAPH-01e | Sentinel OIDs skipped (no paths for __wip__) | unit | `npx vitest run src/lib/graph-svg-data.test.ts -t "sentinel"` | No -- Wave 0 |
| GRAPH-01f | Reactivity: $derived.by() recomputes on data change only | manual-only | Visual inspection / Svelte devtools | N/A -- reactive integration is structural |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/graph-svg-data.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `vitest` + `@sveltejs/vite-plugin-svelte` dev dependency install: `npm install -D vitest`
- [ ] `vitest.config.ts` or inline config in `vite.config.ts`
- [ ] `src/lib/graph-svg-data.test.ts` -- covers GRAPH-01a through GRAPH-01e
- [ ] Test helper: `makeCommit()` factory for creating GraphCommit test fixtures

## Discretion Recommendations

### Edge Granularity: One Path Per Parent-Child Link
**Recommendation:** One path per parent-child edge relationship, not per lane segment.

Rationale: Each `GraphCommit` has `edges: GraphEdge[]` that describe how it connects to adjacent rows. A "straight" edge in column N means "draw a vertical line in column N from this row to the next." A merge/fork edge means "draw a connection path from column A to column B." By generating one path per edge, we directly map git's data model. Lane segments (grouping consecutive straight edges) would require tracking which edges belong to the same "lane" across rows -- added complexity with minimal benefit since SVG renders thousands of `<path>` elements efficiently.

### Module Boundary: New `src/lib/graph-svg-data.ts`
**Recommendation:** New standalone module in `src/lib/`.

Rationale: The path generation is pure computation (no Svelte, no DOM, no IPC). Placing it in `src/lib/` makes it importable from any component and testable with vitest without Svelte component testing infrastructure. This follows the existing pattern where `graph-constants.ts`, `store.ts`, `types.ts` are all pure lib modules.

### Synthetic Row Scope: Defer to Phase 17
**Recommendation:** Skip sentinel OIDs (`__wip__`, `__stash_N__`) in Phase 15 path computation.

Rationale: Phase 17 (SYNTH-01, SYNTH-02) explicitly covers WIP and stash row rendering. The current WIP row has special rendering (dashed line, hollow dot) that doesn't fit the general path model. Filtering sentinels out keeps Phase 15 focused and avoids rework when Phase 17 designs the synthetic row SVG approach.

## Sources

### Primary (HIGH confidence)
- Project source code: `src/components/LaneSvg.svelte` -- current Manhattan routing implementation (`buildEdgePath()`)
- Project source code: `src/lib/graph-constants.ts` -- LANE_WIDTH=12, ROW_HEIGHT=26, DOT_RADIUS=6
- Project source code: `src/lib/types.ts` -- GraphCommit, GraphEdge, EdgeType type definitions
- Project source code: `src-tauri/src/git/graph.rs` -- Rust lane algorithm producing edge data
- Project source code: `src/components/CommitGraph.svelte` -- current `$derived.by()` usage pattern, batch loading, displayItems

### Secondary (MEDIUM confidence)
- SVG path specification: `M`, `H`, `V`, `A` commands are stable SVG 1.1 standard
- Svelte 5 `$derived.by()` reactivity: consistent with project's existing usage

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all existing project tech
- Architecture: HIGH -- based on direct analysis of current `buildEdgePath()` and data flow
- Pitfalls: HIGH -- identified from actual code patterns (pagination, sentinel OIDs, arc directions)

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable domain -- SVG paths and Svelte 5 reactivity are well-established)
