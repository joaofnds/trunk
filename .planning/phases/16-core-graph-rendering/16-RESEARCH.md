# Phase 16: Core Graph Rendering - Research

**Researched:** 2026-03-12
**Domain:** SVG rendering, viewBox clipping, Svelte 5 component architecture
**Confidence:** HIGH

## Summary

Phase 16 replaces the current per-row `LaneSvg.svelte` renderer with a new component that consumes pre-computed `graphSvgData` (from Phase 15) and renders viewBox-clipped bands of continuous SVG paths. The data engine is complete and tested -- this phase is purely about rendering that data with zero visual difference from v0.3.

The core challenge is threading the `graphSvgData` Map from `CommitGraph.svelte` (where it is computed at line 259-261) to each row component, then rendering each row's SVG element with a `viewBox` that clips into the correct Y band of the global coordinate space. Sentinel rows (WIP/stash) must continue rendering with the old `LaneSvg` approach since `computeGraphSvgData` explicitly skips them.

**Primary recommendation:** Create a new `GraphCell.svelte` component that receives the full `graphSvgData` Map plus the row index and commit, renders a viewBox-clipped SVG with three z-layers (rails, edges, dots), and falls back to `LaneSvg` for sentinel OIDs. Thread the Map via Svelte context to avoid prop drilling through the virtual list.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
No locked decisions -- all implementation choices are at Claude's discretion.

### Claude's Discretion
All implementation decisions are at Claude's discretion. The user trusts technical judgment on all areas below:

**Transition strategy:**
- Whether to replace LaneSvg.svelte entirely or adapt it to consume pre-computed paths
- How to handle WIP/stash rows during Phase 16 (before Phase 17 adapts them) -- options include keeping old LaneSvg for sentinels only, or rendering sentinels with a simple fallback
- Whether to create a new component or modify LaneSvg in-place

**Path data threading:**
- How `graphSvgData` (Map<string, SvgPathData> computed in CommitGraph.svelte) reaches each row -- prop drilling, Svelte context (setContext/getContext), or row-index-based lookup
- Whether each row receives the full map and filters, or CommitGraph pre-filters per row

**ViewBox clipping approach:**
- How to structure the per-row SVG element -- viewBox offset into global Y coordinates vs translated SVG group
- How paths are filtered per visible row (render all paths and let viewBox clip, or only render paths that intersect the row's Y band)
- Three-layer z-stacking preservation (rails, edges, dots) in the new structure

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RENDER-01 | Each visible graph row renders a viewBox-clipped band of the full SVG paths (no per-row seams) | ViewBox clipping pattern, path filtering strategy, GraphCell component architecture |
| RENDER-02 | Commit dots render as individual SVG elements (filled for regular, hollow for merges) | Dot rendering code from LaneSvg.svelte lines 113-140, exact attribute preservation |
| RENDER-03 | Graph rendering produces identical visual output to v0.3 | Color system (8 lane CSS vars), stroke widths, dot radii, z-layer ordering from LaneSvg |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5 | Component framework | Already in use, $derived.by() for reactive computations |
| vitest | 4.1.0 | Unit testing | Already configured for project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @humanspeak/svelte-virtual-list | existing | Virtual scrolling | Already wraps commit rows, no changes needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Svelte context | Prop drilling | Context avoids modifying CommitRow props and virtual list snippet; prop drilling is simpler but requires touching more files |
| New GraphCell component | Modify LaneSvg in-place | New component keeps old rendering as fallback for sentinels; modifying in-place risks breaking sentinel rendering |

**Installation:**
No new dependencies required. Zero new runtime dependencies is a v0.4 decision.

## Architecture Patterns

### Recommended Component Structure
```
src/
├── components/
│   ├── GraphCell.svelte     # NEW: viewBox-clipped SVG renderer consuming graphSvgData
│   ├── LaneSvg.svelte       # KEEP: used as fallback for sentinel rows (WIP/stash)
│   ├── CommitRow.svelte     # MODIFY: replace LaneSvg with GraphCell for non-sentinel rows
│   └── CommitGraph.svelte   # MODIFY: provide graphSvgData via Svelte context
└── lib/
    ├── graph-svg-data.ts    # EXISTING: computeGraphSvgData() -- no changes needed
    ├── graph-constants.ts   # EXISTING: constants -- no changes needed
    └── types.ts             # EXISTING: SvgPathData type -- no changes needed
```

### Pattern 1: Svelte Context for Data Threading
**What:** Use `setContext`/`getContext` to pass the `graphSvgData` Map and `displayItems` array from CommitGraph to row components without modifying the virtual list snippet interface.
**When to use:** When data must cross a component boundary that you don't control (the virtual list's `renderItem` snippet).
**Example:**
```typescript
// CommitGraph.svelte
import { setContext } from 'svelte';
setContext('graphSvgData', { get data() { return graphSvgData; } });
// Wrap in getter so context consumers get reactive updates

// GraphCell.svelte
import { getContext } from 'svelte';
const ctx = getContext<{ readonly data: Map<string, SvgPathData> }>('graphSvgData');
// Access ctx.data reactively
```

**IMPORTANT Svelte 5 context reactivity note:** `setContext` runs once. To make the value reactive, pass an object with a getter that reads the `$derived` value, or pass a function. Do NOT pass the Map directly -- it will be a snapshot, not reactive.

### Pattern 2: ViewBox Clipping Per Row
**What:** Each row renders an `<svg>` element whose `viewBox` is offset to the row's Y band in global coordinates, showing only the paths that pass through that row's vertical slice.
**When to use:** Every non-sentinel row.
**Example:**
```svelte
<!-- Row at index i shows Y band from i*ROW_HEIGHT to (i+1)*ROW_HEIGHT -->
<svg
  width={svgWidth}
  height={ROW_HEIGHT}
  viewBox="0 {rowIndex * ROW_HEIGHT} {svgWidth} {ROW_HEIGHT}"
  style="overflow: hidden; flex-shrink: 0;"
>
  <!-- Layer 1: Rails (straight vertical paths) -->
  {#each railPaths as path}
    <path d={path.d} fill="none" stroke={laneColor(path.colorIndex)} stroke-width={EDGE_STROKE} stroke-linecap="butt" />
  {/each}

  <!-- Layer 2: Connection edges (merge/fork) -->
  {#each connectionPaths as path}
    <path d={path.d} fill="none" stroke={laneColor(path.colorIndex)} stroke-width={EDGE_STROKE} stroke-linecap="round" />
  {/each}

  <!-- Layer 3: Commit dot -->
  <circle cx={dotCx} cy={rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2} r={DOT_RADIUS} ... />
</svg>
```

### Pattern 3: Path Filtering Per Row (Render Only Intersecting Paths)
**What:** For each visible row, filter the `graphSvgData` Map to only render paths whose Y coordinates intersect the row's band, rather than rendering all paths and relying on viewBox clipping.
**When to use:** Performance optimization -- reduces SVG DOM elements per row from O(total_paths) to O(paths_in_row).
**Key insight:** The path keys contain the commit OID. Since each path spans at most 1 row (straight edges span exactly one row, connection edges span exactly one row), filtering by OID matching the current row is efficient. A row at index `i` needs:
- Paths keyed with the OID of `displayItems[i]` (edges originating from this commit)
- Paths from neighboring rows whose edges extend into this row's Y band (pass-through rails)

**Recommended approach:** Since `computeGraphSvgData` generates paths per-commit with absolute Y coordinates, and each path spans exactly one row, the current row `i` only needs paths from `displayItems[i]`. Pass-through vertical rails are already generated as straight edges on each row they traverse. No cross-row filtering is needed.

### Pattern 4: Sentinel Fallback
**What:** WIP (`__wip__`) and stash (`__stash_N__`) rows are skipped by `computeGraphSvgData`. Keep using `LaneSvg` for these until Phase 17.
**When to use:** When `commit.oid.startsWith('__')`.
**Example:**
```svelte
<!-- In CommitRow.svelte graph column -->
{#if commit.oid.startsWith('__')}
  <LaneSvg {commit} {maxColumns} />
{:else}
  <GraphCell {commit} rowIndex={...} {maxColumns} />
{/if}
```

**Challenge:** CommitRow needs to know its `rowIndex` in `displayItems` for viewBox offset. Options:
1. Thread rowIndex as a prop (requires modifying the virtual list snippet call)
2. Compute rowIndex from `displayItems` via context lookup
3. Use `displayItems.indexOf(commit)` -- O(n) per row, acceptable for visible rows only

Recommended: Thread `rowIndex` by modifying the `renderItem` snippet in CommitGraph. The virtual list already provides the item; we can also pass the index. Check if `@humanspeak/svelte-virtual-list` provides index in renderItem.

### Anti-Patterns to Avoid
- **Rendering all paths in every row SVG:** Even with viewBox clipping, putting all paths in every row creates O(n*m) DOM elements. Filter paths per row.
- **Breaking the three-layer z-order:** Rails must be below edges, edges below dots. Each layer must be a separate group or rendered in order within the SVG.
- **Using `overflow: visible` on the new SVG:** The old LaneSvg uses `overflow: visible` because paths intentionally bleed into adjacent rows. The new viewBox-clipped approach must use `overflow: hidden` since the viewBox handles the coordinate mapping.
- **Forgetting `stroke-linecap` differences:** Rails use `butt`, connection paths use `round`. This is a visual fidelity detail.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Path d-string computation | Manual path building in renderer | `computeGraphSvgData()` from Phase 15 | Already tested with 15 unit tests, matches LaneSvg exactly |
| Virtual scrolling | Custom scroll virtualization | `@humanspeak/svelte-virtual-list` | Already integrated, handles 10k+ items |
| Lane color computation | Inline color logic | `laneColor()` helper: `var(--lane-${idx % 8})` | 8-color palette defined in app.css |
| Row height/lane width | Magic numbers | Constants from `graph-constants.ts` | Single source of truth |

**Key insight:** Phase 15 already did the heavy lifting. Phase 16's job is purely rendering -- consume the Map, clip via viewBox, render dots. No path computation should happen in the rendering layer.

## Common Pitfalls

### Pitfall 1: Svelte 5 Context Reactivity
**What goes wrong:** Passing `graphSvgData` Map directly to `setContext` creates a non-reactive snapshot. When commits load/change, the context value doesn't update.
**Why it happens:** Svelte 5 context is set once. Unlike `$state`, it doesn't auto-track.
**How to avoid:** Pass an object with a getter that reads the reactive `$derived` value, or pass a function.
**Warning signs:** Graph renders correctly on first load but doesn't update when scrolling loads more commits.

### Pitfall 2: Row Index Mismatch
**What goes wrong:** The viewBox Y offset uses the wrong row index, causing paths to render at incorrect vertical positions (shifted up/down by one row).
**Why it happens:** The WIP row is prepended to `displayItems` when `wipCount > 0`, shifting all real commit indices by 1. If rowIndex is computed from the commits array instead of displayItems, everything is off by one.
**How to avoid:** `computeGraphSvgData` is called on `displayItems` (which already includes WIP). The row index must match the position in `displayItems`, not in `commits`.
**Warning signs:** All paths appear shifted by exactly ROW_HEIGHT (26px).

### Pitfall 3: viewBox Coordinate Space vs Local Coordinates
**What goes wrong:** Dots render at local coordinates (e.g., `cy = ROW_HEIGHT/2 = 13`) but paths use global coordinates (e.g., `cy = rowIndex * ROW_HEIGHT + 13`). They don't align.
**Why it happens:** Mixing coordinate systems -- paths from `graphSvgData` use absolute Y, but dots might be placed in local SVG space.
**How to avoid:** Dots MUST also use global Y coordinates (`rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2`) since the viewBox maps global coordinates to the visible area.
**Warning signs:** Dots appear at the top of every row regardless of their actual position.

### Pitfall 4: Branch Tip Starting Position
**What goes wrong:** Branch tip commits show a line extending to the top of the row instead of starting from the dot center.
**Why it happens:** The `isBranchTipOwnColumn` check in `computeGraphSvgData` handles this, but if the renderer adds its own rail logic, it may duplicate or conflict.
**How to avoid:** Trust the paths from `graphSvgData` completely. The renderer should NOT add any rail logic -- that's already handled in the data.
**Warning signs:** Double lines or extra line segments at branch tips.

### Pitfall 5: Missing Pass-Through Rails
**What goes wrong:** Vertical lines have gaps between rows where no commit exists in that column.
**Why it happens:** `computeGraphSvgData` generates one straight edge per row that HAS a commit with that edge. Rows without a commit in that column don't generate a path, but the visual line should still pass through.
**Actually not a problem:** Looking at the data model, every row that needs a vertical line in a column has a `Straight` edge in that column. The Rust backend generates edges for pass-through lanes. This is already correct.

### Pitfall 6: SVG Width Inconsistency
**What goes wrong:** Some rows have narrower SVGs than others, causing the graph column to jump.
**Why it happens:** Using `commit.column + 1` instead of `maxColumns` for SVG width.
**How to avoid:** Always use `Math.max(maxColumns, commit.column + 1) * LANE_WIDTH` for SVG width, matching the current LaneSvg behavior.
**Warning signs:** Graph column width changes as you scroll past commits with different column counts.

## Code Examples

Verified patterns from the existing codebase:

### Current LaneSvg Three-Layer Structure (Reference for Visual Fidelity)
```svelte
<!-- Source: src/components/LaneSvg.svelte -->
<!-- Layer 1: Vertical rail lines (bottom z-order) -->
<line stroke-width={EDGE_STROKE} stroke-linecap="butt" />

<!-- Layer 2: Merge/Fork connection paths (middle z-order) -->
<path fill="none" stroke-width={EDGE_STROKE} stroke-linecap="round" />

<!-- Layer 3: Commit dot (top z-order) -->
<!-- Regular: filled circle -->
<circle r={DOT_RADIUS} fill={laneColor(commit.color_index)} />
<!-- Merge: hollow circle with background fill -->
<circle r={DOT_RADIUS} fill="var(--color-bg)" stroke={laneColor(commit.color_index)} stroke-width={MERGE_STROKE} />
```

### Dot Rendering (Must Match Exactly)
```svelte
<!-- Regular commit dot -->
<circle
  cx={cx(commit.column)}
  cy={rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2}
  r={DOT_RADIUS}
  fill={laneColor(commit.color_index)}
/>

<!-- Merge commit dot (hollow) -->
<circle
  cx={cx(commit.column)}
  cy={rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2}
  r={DOT_RADIUS}
  fill="var(--color-bg)"
  stroke={laneColor(commit.color_index)}
  stroke-width={MERGE_STROKE}
/>
```

### Path Rendering from graphSvgData
```svelte
<!-- Straight edges (rails) use stroke-linecap="butt" -->
<path d={path.d} fill="none" stroke={laneColor(path.colorIndex)} stroke-width={EDGE_STROKE} stroke-linecap="butt" />

<!-- Connection edges use stroke-linecap="round" -->
<path d={path.d} fill="none" stroke={laneColor(path.colorIndex)} stroke-width={EDGE_STROKE} stroke-linecap="round" />
```

### Key Constants (from graph-constants.ts)
```typescript
LANE_WIDTH = 12    // pixels per column
ROW_HEIGHT = 26    // pixels per row
DOT_RADIUS = 6     // commit dot radius
EDGE_STROKE = 1    // line/path stroke width
WIP_STROKE = 1.5   // WIP dashed stroke width
MERGE_STROKE = 2   // merge dot hollow stroke width
```

### Lane Color Helper
```typescript
const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
// 8 colors defined in app.css:
// --lane-0: #58a6ff (blue)   --lane-4: #7ee787 (green)
// --lane-1: #f78166 (orange) --lane-5: #ffa657 (amber)
// --lane-2: #f778ba (pink)   --lane-6: #79c0ff (light blue)
// --lane-3: #d2a8ff (purple) --lane-7: #ff7b72 (red)
```

## State of the Art

| Old Approach (v0.3) | New Approach (v0.4 Phase 16) | When Changed | Impact |
|---------------------|------------------------------|--------------|--------|
| Per-row path computation in LaneSvg | Pre-computed paths in graphSvgData Map | Phase 15 (data), Phase 16 (rendering) | Eliminates row-boundary seam bugs |
| Local SVG coordinates per row | Global absolute Y coordinates + viewBox clipping | Phase 16 | Continuous paths, no coordinate recalculation per row |
| Each row computes its own edges | Paths pre-computed once, rendered via lookup | Phase 15-16 | Single source of truth for all path geometry |

## Open Questions

1. **Virtual list renderItem index availability**
   - What we know: `SvelteVirtualList` provides items via `{#snippet renderItem(commit)}` -- only the item, not the index
   - What's unclear: Whether the library supports passing the index as a second argument to renderItem
   - Recommendation: Check the library source. If index is not provided, compute it via `displayItems.indexOf(commit)` or pass displayItems via context and derive index. Since only ~20-30 rows are visible at once, `indexOf` is O(n) on a small visible set. Alternatively, add a `_rowIndex` field to each displayItem during the `$derived.by()` computation.

2. **Path type discrimination for stroke-linecap**
   - What we know: Rails (straight/rail paths) need `stroke-linecap="butt"`, connections need `"round"`
   - What's unclear: The key format encodes this (`straight`, `rail` vs `MergeLeft` etc.) but extracting it requires string parsing
   - Recommendation: When filtering paths per row, categorize them by key pattern. Keys containing `:straight:` or `:rail:` are rails; all others are connections. This is reliable since key format is defined in computeGraphSvgData.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | Inline in package.json (`"test": "vitest run"`) |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RENDER-01 | viewBox clipping renders correct Y band per row | unit | `npx vitest run src/lib/graph-cell.test.ts -t "viewBox"` | No -- Wave 0 |
| RENDER-02 | Dots render correctly (filled vs hollow) | manual-only | Visual inspection in dev mode | N/A |
| RENDER-03 | Visual parity with v0.3 | manual-only | Side-by-side comparison in app | N/A |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green + visual inspection before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/lib/graph-cell.test.ts` -- unit tests for path filtering/categorization logic (if extracted to a helper)
- RENDER-02 and RENDER-03 are inherently visual and require manual verification in the running app. No automated test can fully cover "visual parity."
- Existing `graph-svg-data.test.ts` (15 tests) covers the data layer -- no changes needed there.

## Sources

### Primary (HIGH confidence)
- Source code analysis: `LaneSvg.svelte`, `CommitGraph.svelte`, `CommitRow.svelte`, `graph-svg-data.ts`, `graph-constants.ts`, `types.ts` -- full read of all relevant files
- `app.css` -- lane color CSS variables verified
- `graph-svg-data.test.ts` -- 15 existing tests confirming path computation correctness

### Secondary (MEDIUM confidence)
- `@humanspeak/svelte-virtual-list` type definitions -- confirmed renderItem snippet API
- Svelte 5 context reactivity model -- based on Svelte 5 runes documentation

### Tertiary (LOW confidence)
- Virtual list `renderItem` index parameter availability -- needs verification against library source

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing code thoroughly analyzed
- Architecture: HIGH -- clear data flow from computeGraphSvgData through context to per-row renderer
- Pitfalls: HIGH -- all pitfalls identified from actual code analysis (coordinate systems, context reactivity, index offsets)
- ViewBox clipping approach: HIGH -- SVG viewBox is a well-understood web standard
- Virtual list index threading: MEDIUM -- needs verification of library API

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable domain, no external dependencies changing)
