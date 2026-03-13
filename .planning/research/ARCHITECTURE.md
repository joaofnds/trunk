# Architecture Research: Single SVG Overlay Graph Integration

**Domain:** Git GUI — commit graph rendering with virtual scrolling
**Researched:** 2026-03-13
**Confidence:** HIGH (based on direct codebase analysis, SVG/CSS specs, virtual list internals)

## System Overview: Current vs Target

### Current Architecture (v0.3–v0.4)

```
┌─────────────────────────────────────────────────────────────────┐
│  CommitGraph.svelte (orchestrator)                               │
│  ├── displayItems = $derived (WIP + commits)                     │
│  ├── graphSvgData = $derived (computeGraphSvgData)               │
│  └── setContext('graphSvgData', ...)                              │
├─────────────────────────────────────────────────────────────────┤
│  SvelteVirtualList                                               │
│  ├── viewport (overflow-y: scroll)                               │
│  │   └── content (height: totalHeight px)                        │
│  │       └── items (transform: translateY)                       │
│  │           ├── CommitRow[0]                                    │
│  │           │   ├── RefPill (HTML) ← connector line             │
│  │           │   ├── GraphCell (per-row SVG, viewBox clipped)    │
│  │           │   ├── Message, Author, Date, SHA (HTML)           │
│  │           ├── CommitRow[1] ...                                │
│  │           └── ~40 visible DOM nodes                           │
├─────────────────────────────────────────────────────────────────┤
│  Rust Backend                                                    │
│  ├── graph.rs → walk_commits → GraphResult { commits, max_cols } │
│  └── GraphCommit { oid, column, color_index, edges[], refs[] }   │
└─────────────────────────────────────────────────────────────────┘
```

**Key detail:** Each CommitRow has its own `<svg>` element in GraphCell. The SVG uses `viewBox="0 {rowIndex * ROW_HEIGHT} {svgWidth} {ROW_HEIGHT}"` to clip to just its row's band from a conceptually full-height coordinate space. Edges are per-row Manhattan routes that don't cross row boundaries.

### Target Architecture (v0.5)

```
┌─────────────────────────────────────────────────────────────────┐
│  CommitGraph.svelte (orchestrator)                               │
│  ├── displayItems = $derived (WIP + commits) [UNCHANGED]         │
│  ├── graphData = $derived (buildGraphData) [NEW — replaces       │
│  │     computeGraphSvgData with Active Lanes transformation]     │
│  └── setContext('graphOverlay', ...)                              │
├─────────────────────────────────────────────────────────────────┤
│  ┌── SvelteVirtualList ─────────────────────────────────────┐    │
│  │  viewport (overflow-y: scroll) ← scroll source            │    │
│  │  └── content (height: totalHeight px)                     │    │
│  │      ├── GraphOverlay.svelte [NEW]                        │    │
│  │      │   └── <svg> (position: absolute, pointer-          │    │
│  │      │        events: none, full content height)           │    │
│  │      │        ├── <g> edges (cubic bezier paths)           │    │
│  │      │        ├── <g> dots (circles)                       │    │
│  │      │        └── <g> ref pills (rect + text)              │    │
│  │      └── items (transform: translateY)                     │    │
│  │          ├── CommitRow[0] [MODIFIED — no GraphCell]        │    │
│  │          │   ├── graph spacer div (width only)             │    │
│  │          │   ├── Message, Author, Date, SHA                │    │
│  │          └── ~40 visible DOM nodes                         │    │
│  └──────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│  TypeScript Transformation Layer [NEW]                           │
│  └── active-lanes.ts: GraphCommit[] → GraphData                  │
│      { nodes: GraphNode[], edges: GraphEdge[], refPills: ... }   │
├─────────────────────────────────────────────────────────────────┤
│  Rust Backend [UNCHANGED]                                        │
│  └── graph.rs → walk_commits → GraphResult                       │
└─────────────────────────────────────────────────────────────────┘
```

## Component Inventory: New, Modified, Deleted

| Component | Status | Responsibility |
|-----------|--------|----------------|
| `active-lanes.ts` | **NEW** | TS transformation: `GraphCommit[]` → `GraphData` with integer grid coordinates |
| `active-lanes.test.ts` | **NEW** | Unit tests for the transformation layer |
| `graph-overlay-types.ts` | **NEW** | Type definitions: `GraphNode`, `GraphEdge`, `GraphRefPill`, `GraphData` |
| `graph-overlay-paths.ts` | **NEW** | Cubic bezier path builder: grid coords → SVG `d` strings |
| `graph-overlay-paths.test.ts` | **NEW** | Unit tests for bezier path generation |
| `GraphOverlay.svelte` | **NEW** | Single SVG overlay component with all graph elements |
| `SvgRefPill.svelte` | **NEW** | SVG `<rect>` + `<text>` ref pill (replaces HTML RefPill in graph context) |
| `CommitGraph.svelte` | **MODIFIED** | Replace `computeGraphSvgData` with `buildGraphData`, inject overlay context, adjust column layout |
| `CommitRow.svelte` | **MODIFIED** | Remove GraphCell, replace with spacer div; remove HTML ref pill column; remove connector line |
| `graph-constants.ts` | **MODIFIED** | Add new constants: `OVERLAY_LANE_WIDTH`, `OVERLAY_ROW_HEIGHT`, `BEZIER_CURVATURE` |
| `types.ts` | **MODIFIED** | Add new overlay type exports |
| `GraphCell.svelte` | **DELETED** | Replaced by GraphOverlay |
| `LaneSvg.svelte` | **DELETED** | Already superseded by GraphCell in v0.4; fully removed |
| `graph-svg-data.ts` | **DELETED** | Replaced by active-lanes.ts + graph-overlay-paths.ts |
| `graph-svg-data.test.ts` | **DELETED** | Replaced by active-lanes.test.ts |
| `RefPill.svelte` | **KEPT** (for sidebar) | Still used in BranchSidebar; no longer used inside CommitRow |

## Architectural Patterns

### Pattern 1: SVG Overlay Inside Virtual List Content

**What:** Place the single `<svg>` element inside the virtual list's content div (the one sized to `totalHeight`), as a sibling of the items container. The SVG has `position: absolute; top: 0; left: 0; pointer-events: none` and its height matches the content's total height.

**Why this approach:**
- The SVG scrolls naturally with the virtual list's scroll container — no manual scroll synchronization needed
- The browser's native scrolling handles pixel-perfect alignment
- The content div already has `position: relative` and is sized to `totalHeight` pixels
- SVG `pointer-events: none` lets clicks fall through to the HTML rows beneath
- Browser only paints visible portion of offscreen SVG elements — no performance penalty for full-height SVG

**Why not other approaches:**
- ❌ **SVG as sibling with scroll listener**: Requires manual `scrollTop` sync, introduces frame lag, complex event forwarding
- ❌ **SVG with viewBox scroll**: viewBox changes on every scroll event cause SVG re-render, expensive for large graphs
- ❌ **SVG outside virtual list with `transform: translateY`**: Must mirror virtual list's internal transform math, fragile coupling

**Virtual list DOM structure (from source analysis of `@humanspeak/svelte-virtual-list` v0.4.2):**

```html
<!-- container: position relative, overflow hidden -->
<div class="virtual-list-container">
  <!-- viewport: position absolute, inset 0, overflow-y scroll -->
  <div class="virtual-list-viewport">
    <!-- content: position relative, height = totalHeight -->
    <div id="virtual-list-content" class="virtual-list-content"
         style="height: {contentHeight}px">
      <!-- items: position absolute, transform translateY -->
      <div id="virtual-list-items" class="virtual-list-items"
           style="transform: translateY({transformY}px)">
        <!-- rendered item wrappers -->
      </div>
    </div>
  </div>
</div>
```

**Injection approach:** The SVG must become a child of `.virtual-list-content`. Since the library doesn't expose a content slot, use a Svelte `$effect` + DOM manipulation after mount:

```typescript
// In CommitGraph.svelte
let overlayEl = $state<HTMLElement | null>(null);
let wrapperEl = $state<HTMLElement | null>(null);

$effect(() => {
  if (!wrapperEl || !overlayEl) return;
  const content = wrapperEl.querySelector('.virtual-list-content');
  if (content && overlayEl.parentElement !== content) {
    content.prepend(overlayEl); // Move SVG into content div
  }
});
```

**Robustness concern:** This couples to the virtual list's internal DOM structure (class name `.virtual-list-content`). Mitigated by:
- Pinning library version (`"@humanspeak/svelte-virtual-list": "^0.4.2"`)
- The library also uses `id="virtual-list-content"` as a fallback selector
- Adding a comment explaining the coupling

**Trade-offs:**
- ✅ Zero scroll sync code — SVG moves with content naturally
- ✅ Browser only composites visible portion (GPU layer)
- ⚠️ Full-height SVG DOM node exists (but browsers don't render offscreen paths)
- ⚠️ Requires DOM injection into third-party component's internals

### Pattern 2: Active Lanes Transformation (TS Layer)

**What:** A pure TypeScript function that takes Rust's `GraphCommit[]` output and produces `GraphData` — a flattened set of nodes, edges, and ref pills with integer grid coordinates `(x: lane, y: row)`.

**Why:** Rust's lane algorithm computes per-row edge descriptors (from_column, to_column, edge_type). The overlay needs multi-row continuous paths. Rather than modifying the Rust algorithm (proven, ~5ms/10k), a TS transformation layer bridges the gap by:
1. Walking commits in order
2. Tracking active lanes (which lane IDs are alive at each row)
3. Building edge spans that connect parent→child across arbitrary row counts
4. Outputting grid coordinates that the path builder converts to pixel SVG paths

**Grid coordinate system:**
- `x` = integer lane index (0, 1, 2, ...)
- `y` = integer row index (0, 1, 2, ...)
- Pixel conversion deferred to path builder: `px_x = x * LANE_WIDTH + LANE_WIDTH/2`, `px_y = y * ROW_HEIGHT + ROW_HEIGHT/2`

**Key types:**

```typescript
interface GraphNode {
  id: string;           // commit oid
  x: number;            // lane index
  y: number;            // row index
  colorIndex: number;
  isMerge: boolean;
  isBranchTip: boolean;
  isWip: boolean;
  isStash: boolean;
}

interface GraphEdgeSpan {
  id: string;           // unique edge ID
  colorIndex: number;
  dashed: boolean;
  sourceX: number;      // lane at start (parent commit)
  sourceY: number;      // row at start
  targetX: number;      // lane at end (child commit)
  targetY: number;      // row at end
  type: 'straight' | 'merge' | 'fork';
}

interface GraphRefPill {
  commitId: string;
  x: number;            // lane of the commit
  y: number;            // row index
  colorIndex: number;
  refs: RefLabel[];
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdgeSpan[];
  refPills: GraphRefPill[];
  maxLanes: number;
}
```

**Edge coalescing — critical optimization:** Consecutive straight edges in the same lane (e.g., lane 0 rows 0-50) must be merged into a single `GraphEdgeSpan` producing one `<path>` instead of 50 separate segments. The transformation walks the commit array, tracking active lanes, and emits one edge span per continuous lane segment. This is the key optimization that reduces SVG DOM node count from O(commits × lanes) to O(lanes + merge_edges).

**Trade-offs:**
- ✅ Rust algorithm stays unchanged — proven O(n) with all edge cases handled
- ✅ TS transformation is pure function → easily unit-testable
- ✅ Grid coordinates decouple layout from rendering
- ⚠️ Adds ~2-3ms processing for 10k commits (negligible vs Rust's 5ms)
- ⚠️ Must handle the same edge cases (WIP, stash, sentinel OIDs)

### Pattern 3: Cubic Bezier Path Generation

**What:** Convert `GraphEdgeSpan` grid coordinates into SVG `<path d="...">` strings using cubic bezier curves instead of Manhattan routing.

**Path types:**

1. **Straight edge** (same lane, spanning rows):
   `M {x} {y1} L {x} {y2}` — simple vertical line

2. **Merge/Fork edge** (different lanes):
   ```
   M {sourceX} {sourceY}
   C {sourceX} {sourceY + curvature},
     {targetX} {targetY - curvature},
     {targetX} {targetY}
   ```
   Where curvature = `|targetY - sourceY| * 0.4` (tunable)

3. **WIP dashed connector**: Same as straight but with `stroke-dasharray`

**Example:**

```typescript
function buildBezierPath(edge: GraphEdgeSpan, constants: GraphConstants): string {
  const sx = edge.sourceX * constants.laneWidth + constants.laneWidth / 2;
  const sy = edge.sourceY * constants.rowHeight + constants.rowHeight / 2;
  const tx = edge.targetX * constants.laneWidth + constants.laneWidth / 2;
  const ty = edge.targetY * constants.rowHeight + constants.rowHeight / 2;

  if (sx === tx) {
    return `M ${sx} ${sy} L ${tx} ${ty}`;
  }

  const dy = Math.abs(ty - sy);
  const curve = dy * 0.4;
  return `M ${sx} ${sy} C ${sx} ${sy + curve}, ${tx} ${ty - curve}, ${tx} ${ty}`;
}
```

**Trade-offs:**
- ✅ Smooth, professional GitKraken-style appearance
- ✅ Each edge is one `<path>` element regardless of row span
- ✅ No row-boundary seam artifacts
- ⚠️ Need to tune curvature to avoid path overlap at narrow lane widths

## Data Flow

### Complete Data Flow: Rust → Screen

```
Rust (graph.rs)
    │
    │  walk_commits(repo, offset, limit) → GraphResult
    │  { commits: GraphCommit[], max_columns: usize }
    │
    ▼
Tauri IPC (safeInvoke)
    │
    │  get_commit_graph / refresh_commit_graph → GraphResponse
    │
    ▼
CommitGraph.svelte ($state)
    │
    │  commits: GraphCommit[]
    │  maxColumns: number
    │
    ├──► displayItems = $derived  (prepend WIP if needed)
    │
    ├──► graphData = $derived.by(() =>
    │      buildGraphData(displayItems, maxColumns)
    │    )
    │    ├── active-lanes.ts: GraphCommit[] → GraphData
    │    │   { nodes[], edges[], refPills[], maxLanes }
    │    │
    │    └── graph-overlay-paths.ts: GraphData → renderable SVG data
    │        { pathElements[], dotElements[], pillElements[] }
    │
    ├──► setContext('graphOverlay', { get data() { return graphData; } })
    │
    ▼
GraphOverlay.svelte (reads context)
    │
    │  <svg pointer-events="none" width={graphWidth} height={totalHeight}>
    │    <g class="edges">
    │      {#each edges as edge}
    │        <path d={edge.d} stroke={laneColor(edge.colorIndex)} ... />
    │      {/each}
    │    </g>
    │    <g class="dots">
    │      {#each nodes as node}
    │        <circle cx={...} cy={...} r={DOT_RADIUS} ... />
    │      {/each}
    │    </g>
    │    <g class="ref-pills" pointer-events="all">
    │      {#each refPills as pill}
    │        <SvgRefPill {pill} />
    │      {/each}
    │    </g>
    │  </svg>
    │
    ▼
CommitRow.svelte (simplified)
    │
    │  <div> (no GraphCell, no RefPill in graph column)
    │    <div style="width: {graphColumnWidth}px" /> ← spacer
    │    <div> message </div>
    │    <div> author </div>
    │    <div> date </div>
    │    <div> sha </div>
    │  </div>
```

### Event Flow: Click/Context Menu

```
User clicks on commit row area
    │
    ├── Case A: Click on HTML CommitRow (message, author, date, sha)
    │   └── CommitRow onclick fires normally [UNCHANGED]
    │       SVG overlay has pointer-events: none → click passes through
    │
    ├── Case B: Click on SVG ref pill
    │   └── <g class="ref-pills" pointer-events="all">
    │       └── SvgRefPill onclick → dispatch('pillclick', { commitId })
    │           └── CommitGraph handles pill click
    │
    ├── Case C: Click on SVG dot
    │   └── <circle pointer-events="all" data-oid={node.id}>
    │       └── Circle onclick → dispatch('dotclick', { commitId })
    │           └── CommitGraph routes to oncommitselect
    │
    └── Case D: Right-click anywhere on row
        └── CommitRow oncontextmenu fires (SVG has pointer-events: none)
            └── showCommitContextMenu [UNCHANGED]
```

### Scroll Integration

```
User scrolls
    │
    ▼
SvelteVirtualList viewport onscroll
    │
    ├── Virtual list recalculates visible items
    │   └── Mounts/unmounts CommitRow DOM nodes
    │
    └── SVG overlay (inside content div) scrolls naturally
        └── Browser only paints visible SVG region
        └── No JS scroll handler needed for overlay
```

**No scroll synchronization code is needed.** The SVG is a child of the scrollable content div, so it scrolls identically to the HTML items.

## Scaling Considerations

| Concern | 100 commits | 10K commits | 100K commits |
|---------|-------------|-------------|--------------|
| SVG DOM nodes (with edge coalescing) | ~50 | ~1K edges + 10K dots | ~2K edges + 100K dots |
| SVG DOM nodes (without coalescing) | ~300 | ~30K | ❌ 300K too many |
| TS transformation | <1ms | ~3ms | ~30ms |
| Full-height SVG pixel height | 2,600px | 260,000px | 2,600,000px (within limits) |
| Pagination | N/A | 200-batch works | 200-batch limits loaded set |

### Scaling Priorities

1. **First bottleneck (10K+): SVG DOM node count.** With edge coalescing, ~1K edge paths + 10K dot circles ≈ 11K nodes. Without: ~30K. Coalescing is critical.

2. **Second bottleneck (100K+): SVG height limit.** 100K × 26px = 2.6M px. Chrome supports ~33M px, Firefox ~16M px. Safe for realistic repos.

3. **Future optimization if needed:** Viewport-culled SVG rendering — only create elements for visible region + buffer. Defer unless perf testing shows issues.

## Anti-Patterns

### Anti-Pattern 1: Scroll Event Mirroring

**What people do:** Create a second scrollable container for SVG and sync scrollTop on every scroll event.
**Why it's wrong:** Always 1 frame behind, visual tearing, breaks momentum scrolling.
**Do this instead:** Put SVG inside the same scroll container.

### Anti-Pattern 2: Re-rendering SVG on Scroll

**What people do:** Update SVG viewBox or re-render visible elements on every scroll event.
**Why it's wrong:** Forces SVG re-layout per frame, kills scroll performance.
**Do this instead:** Render full SVG once. Let browser handle viewport culling.

### Anti-Pattern 3: Per-Row SVG Fragments with Bridge Logic

**What people do:** Keep per-row SVGs and bridge edges across row boundaries.
**Why it's wrong:** This is v0.3-v0.4. Works for Manhattan routing but fails for bezier curves (seams, inconsistent curvature).
**Do this instead:** Single SVG with continuous paths.

### Anti-Pattern 4: Pixel Coordinates in Rust

**What people do:** Compute SVG pixel coordinates in Rust to skip TS transformation.
**Why it's wrong:** Couples backend to frontend dimensions. Changes require Rust rebuild.
**Do this instead:** Rust outputs integer lane indices. TS converts to pixels.

## Integration Points

### Integration Point 1: SVG Injection into Virtual List

**Challenge:** `@humanspeak/svelte-virtual-list` v0.4.2 doesn't expose a content slot. SVG must become a child of `.virtual-list-content`.

**Approach:** DOM manipulation in Svelte `$effect` after mount:

```typescript
$effect(() => {
  if (!wrapperEl || !overlayHost) return;
  const content = wrapperEl.querySelector('.virtual-list-content');
  if (content && overlayHost.parentElement !== content) {
    content.prepend(overlayHost);
  }
});
```

**Robustness:** Coupled to `.virtual-list-content` class name. Mitigated by pinning library version, `id="virtual-list-content"` as fallback, and documenting the coupling.

### Integration Point 2: Total Height Synchronization

All rows are fixed-height (`ROW_HEIGHT`), so `totalHeight = displayItems.length * ROW_HEIGHT`. This matches virtual list's `defaultEstimatedItemHeight={ROW_HEIGHT}`.

### Integration Point 3: Graph Column Width Sync

`graphWidth = graphData.maxLanes * LANE_WIDTH`. SVG positioned at graph column's x-offset. CommitRow spacer div at same width. Both derived from same `maxLanes`.

### Integration Point 4: Ref Column Migration

Ref pills become SVG `<rect>` + `<text>` elements positioned left of graph dots in the overlay. The HTML "ref" column and connector line in CommitRow are removed.

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Rust ↔ CommitGraph | Tauri IPC (`safeInvoke`) | **Unchanged** |
| CommitGraph ↔ Transformation | Direct function call | `buildGraphData()` in `$derived.by()` |
| CommitGraph ↔ GraphOverlay | Svelte context | `setContext('graphOverlay', ...)` |
| GraphOverlay ↔ CommitRow | None | Independent siblings |
| GraphOverlay ↔ CommitGraph | Custom events | SVG pill/dot interactions dispatch to parent |

## Suggested Build Order

### Phase 1: Types & Constants (no dependencies)
1. Define types in `graph-overlay-types.ts`
2. Add constants to `graph-constants.ts`

### Phase 2: Active Lanes Transformation (depends on Phase 1)
3. Implement `buildGraphData()` in `active-lanes.ts`
4. Write tests in `active-lanes.test.ts` — port scenarios from `graph-svg-data.test.ts`

### Phase 3: Path Builder (depends on Phase 1, parallel with Phase 2)
5. Implement bezier path builder in `graph-overlay-paths.ts`
6. Write path builder tests

### Phase 4: GraphOverlay Component (depends on Phases 2 & 3)
7. Build `GraphOverlay.svelte` and `SvgRefPill.svelte`
8. Test rendering in isolation

### Phase 5: Integration (depends on Phase 4)
9. Modify `CommitGraph.svelte` — new transformation, overlay injection
10. Modify `CommitRow.svelte` — remove GraphCell, add spacer

### Phase 6: Interaction Preservation (depends on Phase 5)
11. Wire SVG click/context-menu to existing handlers
12. Test: row selection, context menu, ref pill behavior

### Phase 7: Cleanup & Tuning (depends on Phase 6)
13. Delete `GraphCell.svelte`, `LaneSvg.svelte`, `graph-svg-data.ts`, `graph-svg-data.test.ts`
14. Tune dimensions and bezier curvature

### Dependency Graph

```
Phase 1 (types/constants)
    │
    ├──► Phase 2 (active-lanes.ts)  ─┐
    │                                 │
    ├──► Phase 3 (path builder)  ─────┤ parallel
    │                                 │
    └─────────────────────────────────┤
                                      ▼
                                Phase 4 (GraphOverlay.svelte)
                                      │
                                      ▼
                                Phase 5 (integration)
                                      │
                                      ▼
                                Phase 6 (interactions)
                                      │
                                      ▼
                                Phase 7 (cleanup)
```

## Sources

- Direct codebase analysis: `CommitGraph.svelte` (493 lines), `CommitRow.svelte` (142 lines), `GraphCell.svelte` (86 lines), `graph-svg-data.ts` (178 lines), `graph.rs` (489+ lines), `types.rs` (188 lines), `graph-constants.ts` (6 lines)
- `@humanspeak/svelte-virtual-list` v0.4.2 source: `SvelteVirtualList.svelte` (1731 lines — DOM structure, CSS, scroll behavior analyzed)
- MDN SVG Reference: `pointer-events` attribute (HIGH confidence — official docs, 2025-03-18)
- MDN SVG Reference: `<path>` element (HIGH confidence — official docs)
- PROJECT.md v0.5 scope definition (authoritative — project docs, 2026-03-13)

---
*Architecture research for: Trunk v0.5 SVG Overlay Graph Integration*
*Researched: 2026-03-13*
