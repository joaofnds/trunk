# Phase 17: Synthetic Row Adaptation - Research

**Researched:** 2026-03-13
**Domain:** SVG rendering — synthetic/sentinel rows (WIP, stash) in viewBox-clipped graph model
**Confidence:** HIGH

## Summary

Phase 17 removes the `LaneSvg.svelte` fallback for sentinel rows (WIP and stash entries) by making `computeGraphSvgData` generate path data for them and `GraphCell.svelte` render them with appropriate visual differentiation (dashed lines, hollow/square dots).

The current architecture has a clean sentinel routing pattern in `CommitRow.svelte` (line 105): `commit.oid.startsWith('__')` routes to `LaneSvg`, while real commits go to `GraphCell`. The `computeGraphSvgData` function explicitly skips sentinels with a `continue` at line 74. This phase must: (1) make `computeGraphSvgData` generate path data for sentinel rows instead of skipping them, (2) extend `SvgPathData` with a `dashed` flag, (3) update `GraphCell.svelte` to render dashed lines and differentiated dot shapes, and (4) remove the sentinel fallback in `CommitRow.svelte`.

**Critical finding:** Stash rows do NOT currently appear in the commit graph at all — they are only in the `BranchSidebar`. Only `__wip__` is synthesized in `CommitGraph.svelte` via `makeWipItem()`. The SYNTH-02 requirement for stash rows rendering with square dots and dashed connectors implies stash entries must ALSO be injected into `displayItems` as synthetic `GraphCommit` objects, which is new functionality beyond just adapting the renderer.

**Primary recommendation:** Split into two sub-tasks: (1) extend `computeGraphSvgData` + `GraphCell` to support dashed paths and differentiated dots for sentinel rows, (2) inject stash entries into the commit graph's `displayItems` array as synthetic `GraphCommit` objects positioned after their parent commit.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SYNTH-01 | WIP row renders with dashed connector to HEAD in the new SVG model | `computeGraphSvgData` must stop skipping `__wip__` and generate a dashed connector path; `GraphCell` must render dashed stroke-dasharray and hollow dashed circle dot |
| SYNTH-02 | Stash rows render with square dots and dashed connectors | Stash entries must be injected into `displayItems` as synthetic GraphCommit objects; `computeGraphSvgData` must generate dashed paths for `__stash_N__` OIDs; `GraphCell` must render `<rect>` dots instead of `<circle>` for stash sentinels |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5.x | Component framework | Already in use; $derived reactive patterns |
| vitest | 4.1.0 | Unit testing | Already configured in project |
| SVG (native) | N/A | Vector graphics rendering | Zero-dependency approach per v0.4 decision |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None | - | - | Zero new dependencies per v0.4 architectural decision |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SVG `<rect>` for square dots | CSS border-radius on `<circle>` | Not possible — SVG circles can't be squared; `<rect>` is the correct SVG primitive |
| stroke-dasharray for dashed | Custom dash pattern via multiple paths | Unnecessary complexity; native SVG dasharray is standard |

## Architecture Patterns

### Current Architecture (What Changes)

```
CommitGraph.svelte
├── makeWipItem() → creates __wip__ GraphCommit
├── displayItems = [wipItem?, ...commits]     ← stash entries NOT included yet
├── computeGraphSvgData(displayItems)         ← SKIPS sentinel OIDs
├── setContext('graphSvgData', ...)
└── CommitRow.svelte
    └── if oid.startsWith('__') → LaneSvg     ← FALLBACK to remove
        else → GraphCell                       ← target renderer
```

### Target Architecture (After Phase 17)

```
CommitGraph.svelte
├── makeWipItem() → creates __wip__ GraphCommit
├── makeStashItems() → creates __stash_N__ GraphCommit[]  ← NEW
├── displayItems = [wipItem?, ...interleaved(commits, stashItems)]  ← NEW
├── computeGraphSvgData(displayItems)  ← NOW handles sentinels
├── setContext('graphSvgData', ...)
└── CommitRow.svelte
    └── GraphCell for ALL rows (no fallback)  ← SIMPLIFIED
        └── GraphCell renders dashed/square based on sentinel type
```

### Pattern 1: SvgPathData Extension for Dashed Lines
**What:** Add an optional `dashed` boolean to the `SvgPathData` interface
**When to use:** When `computeGraphSvgData` generates paths for sentinel rows
**Example:**
```typescript
// src/lib/types.ts
export interface SvgPathData {
  d: string;
  colorIndex: number;
  dashed?: boolean;  // NEW: true for WIP/stash connector lines
}
```

### Pattern 2: WIP Row Path Generation
**What:** Generate a single dashed vertical path from WIP dot center to bottom of row (connecting to HEAD in next row)
**When to use:** When `computeGraphSvgData` encounters `__wip__` OID
**Example:**
```typescript
// In computeGraphSvgData, instead of skipping __wip__:
if (commit.oid === '__wip__') {
  const key = `${commit.oid}:connector:${commit.column}`;
  paths.set(key, {
    d: `M ${cx(commit.column)} ${cy(rowIndex) + DOT_RADIUS} V ${rowBottom(rowIndex) + cy(0)}`,
    colorIndex: commit.color_index,
    dashed: true,
  });
  continue; // no other edges for WIP
}
```
**Note:** The WIP connector in `LaneSvg.svelte` goes from `cy + DOT_RADIUS` to `rowHeight + cy` (i.e., from just below the WIP dot to the center of the next row). In absolute coordinates this is `cy(rowIndex) + DOT_RADIUS` to `cy(rowIndex + 1)`.

### Pattern 3: Stash Entry Injection into displayItems
**What:** Convert `StashEntry` objects into synthetic `GraphCommit` items and interleave them after their parent commit
**When to use:** When building `displayItems` in `CommitGraph.svelte`
**Example:**
```typescript
function makeStashItem(stash: StashEntry, parentCommit: GraphCommit): GraphCommit {
  return {
    oid: `__stash_${stash.index}__`,
    short_oid: stash.short_name,
    summary: stash.name,
    body: null,
    author_name: '',
    author_email: '',
    author_timestamp: 0,
    parent_oids: stash.parent_oid ? [stash.parent_oid] : [],
    column: parentCommit.column,  // same column as parent
    color_index: parentCommit.color_index,
    edges: [{ from_column: parentCommit.column, to_column: parentCommit.column,
              edge_type: 'Straight' as EdgeType, color_index: parentCommit.color_index }],
    refs: [],
    is_head: false,
    is_merge: false,
    is_branch_tip: true,  // no incoming rail needed
  };
}
```

### Pattern 4: GraphCell Dot Differentiation
**What:** Render different dot shapes based on sentinel type
**When to use:** In `GraphCell.svelte` when rendering the commit dot layer
**Example:**
```svelte
<!-- Layer 3: Commit dot -->
{#if commit.oid === '__wip__'}
  <!-- Dashed hollow circle for WIP -->
  <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS}
    fill="none" stroke={laneColor(commit.color_index)}
    stroke-width={WIP_STROKE} stroke-dasharray="1 4" stroke-linecap="round" />
{:else if commit.oid.startsWith('__stash_')}
  <!-- Square dot for stash -->
  <rect x={dotCx - DOT_RADIUS} y={dotCy - DOT_RADIUS}
    width={DOT_RADIUS * 2} height={DOT_RADIUS * 2}
    fill={laneColor(commit.color_index)} />
{:else if commit.is_merge}
  <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS}
    fill="var(--color-bg)" stroke={laneColor(commit.color_index)} stroke-width={MERGE_STROKE} />
{:else}
  <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS}
    fill={laneColor(commit.color_index)} />
{/if}
```

### Anti-Patterns to Avoid
- **Creating separate SyntheticGraphCell component:** Don't fork GraphCell — extend it with conditional rendering to keep one rendering path
- **Modifying Rust backend to include stash entries in graph walk:** Stash entries are not real commits in the revwalk; keep them as frontend-synthesized items
- **Hardcoding row positions for stash items:** Use the same absolute Y coordinate system based on `rowIndex` — virtual scrolling assigns the index
- **Removing the `__` prefix convention:** Other code (context menu, column visibility) relies on `startsWith('__')` checks

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dashed line rendering | Custom multi-segment paths | SVG `stroke-dasharray` attribute | Native SVG; exact values already proven in LaneSvg: `"1 4"` |
| Square dot shapes | Rotated circle or custom path | SVG `<rect>` element | Standard SVG primitive; cleaner than path approximation |
| Stash parent lookup | Linear scan on every render | Pre-built Map from parent_oid to insertion index | O(n) once vs O(n²) repeated |

## Common Pitfalls

### Pitfall 1: WIP Connector Spans Two Rows
**What goes wrong:** The WIP dashed connector in LaneSvg goes from `cy + DOT_RADIUS` (row 0) to `rowHeight + cy` (row 1 center). In the viewBox-clipped model, each row only sees its own viewBox band. A path that extends into the next row's band will be clipped at the row boundary.
**Why it happens:** ViewBox clipping is `0 {rowIndex * ROW_HEIGHT} {width} {ROW_HEIGHT}` — each row only renders its own vertical band.
**How to avoid:** Generate the connector path spanning from WIP row to HEAD row in absolute coordinates. The path data crosses both rows — row 0's viewBox clips the top half, row 1's viewBox clips the bottom half. This is exactly how regular straight edges work (they go from `rowTop(i)` to `rowBottom(i)` which equals `rowTop(i+1)`). The key insight: the WIP connector path should be keyed to appear in BOTH rows' path lookups. Generate two path entries: one keyed to `__wip__:connector:0` (the WIP row) and one keyed to the HEAD commit's OID so it appears in the HEAD row's rendering.
**Warning signs:** Dashed line visible in WIP row but invisible/cut off below it.

### Pitfall 2: Stash Row Index Mismatch After Interleaving
**What goes wrong:** Inserting stash entries into `displayItems` shifts the `rowIndex` of all subsequent commits. The `computeGraphSvgData` function computes absolute Y coordinates based on `rowIndex`, so the path data from Rust-sourced commits (which don't account for synthetic insertions) would be misaligned.
**Why it happens:** `computeGraphSvgData` iterates `displayItems` with index-based positioning — adding stash items before real commits changes their rowIndex.
**How to avoid:** This is already handled correctly. `computeGraphSvgData` uses the array index as `rowIndex` (line 70: `for (let rowIndex = 0; rowIndex < commits.length; rowIndex++)`). As long as stash items are in `displayItems` at the right positions BEFORE `computeGraphSvgData` runs, all Y coordinates will be consistent. The key is to add stash items to `displayItems` BEFORE passing to `computeGraphSvgData`, which is already the pattern used for `__wip__`.
**Warning signs:** Paths appearing at wrong vertical positions; visible vertical gaps.

### Pitfall 3: Stash Entries Need Accurate Parent OID
**What goes wrong:** `StashEntry.parent_oid` is nullable. If null, the stash can't be positioned after its parent commit in the graph.
**Why it happens:** The Rust backend tries to resolve parent_oid via `find_commit(stash_oid)` and gets `parent_id(0)`. This should work for normal stashes but could fail for edge cases.
**How to avoid:** If `parent_oid` is null, skip injecting that stash into the graph (it remains sidebar-only). Or default to placing it at the top of the list (after WIP if present). Existing code in `commands/stash.rs` line 27 resolves parent: `repo.find_commit(stash_oid).ok().and_then(|c| c.parent_id(0).ok())`.
**Warning signs:** Stash rows appearing at unexpected positions or not appearing at all.

### Pitfall 4: GraphCell Context Key Prefix Filtering
**What goes wrong:** `GraphCell.svelte` filters paths by `key.startsWith(prefix)` where `prefix = commit.oid + ':'`. For sentinel rows, this means only paths keyed with `__wip__:` or `__stash_N__:` will be found. The WIP connector path that needs to appear in the HEAD commit's row must be keyed differently.
**Why it happens:** The existing design assumes one row's paths are all keyed with that row's OID prefix.
**How to avoid:** Two options: (A) Key the WIP connector segment that appears in the HEAD row under the HEAD commit's OID (e.g., `{headOid}:wip-connector:0`), or (B) add the WIP connector as a path on the WIP row only, spanning from `cy(0) + DOT_RADIUS` to `rowBottom(0)`, and let the HEAD row's normal straight rail handle the rest. Option B is simpler — the HEAD commit already has a straight edge from `rowTop` to `rowBottom` that includes passing through the dot center. The visual connection comes from the WIP connector ending at `rowBottom(wipRow)` which equals `rowTop(headRow)`, meeting the HEAD straight edge.
**Warning signs:** Gap between WIP dashed line and HEAD commit's graph rendering.

### Pitfall 5: Stash Context Menu Still Needed
**What goes wrong:** `CommitRow.svelte` line 49 suppresses context menu for sentinel rows (`!commit.oid.startsWith('__')`). But Phase 19 (INTERACT-03) requires stash context menus. Modifying this now could break the incremental approach.
**Why it happens:** Phase 17 is about rendering, not interaction. Context menu wiring is Phase 19.
**How to avoid:** Leave the context menu suppression as-is for Phase 17. Phase 19 will handle stash-specific context menus.
**Warning signs:** N/A for Phase 17 scope.

## Code Examples

### WIP Row Rendering in LaneSvg (Current Reference Implementation)

```svelte
<!-- Source: src/components/LaneSvg.svelte lines 66-75 -->
<!-- WIP connector: dashed line from WIP dot to HEAD dot in next row -->
<line
  x1={cx(0)} y1={cy + DOT_RADIUS} x2={cx(0)} y2={rowHeight + cy}
  stroke={laneColor(0)}
  stroke-width={WIP_STROKE}
  stroke-dasharray="1 4"
  stroke-dashoffset="-3"
  stroke-linecap="round"
/>

<!-- WIP dot: dashed hollow circle -->
<circle
  cx={cx(commit.column)} cy={cy} r={DOT_RADIUS}
  fill="none"
  stroke={laneColor(0)}
  stroke-width={WIP_STROKE}
  stroke-dasharray="1 4"
  stroke-linecap="round"
/>
```

### WIP Item Factory (Current)

```typescript
// Source: src/components/CommitGraph.svelte lines 233-251
function makeWipItem(msg: string): GraphCommit {
  return {
    oid: '__wip__',
    short_oid: '',
    summary: msg,
    body: null,
    author_name: '',
    author_email: '',
    author_timestamp: 0,
    parent_oids: [],
    column: 0,
    color_index: 0,
    edges: [{ from_column: 0, to_column: 0, edge_type: 'Straight' as EdgeType, color_index: 0 }],
    refs: [],
    is_head: false,
    is_merge: false,
    is_branch_tip: false,
  };
}
```

### Current computeGraphSvgData Sentinel Skip

```typescript
// Source: src/lib/graph-svg-data.ts lines 73-76
// Skip sentinel OIDs (WIP row, stash entries)
if (commit.oid.startsWith('__')) {
  continue;
}
```

### SVG Dashed Path Rendering Pattern

```svelte
<!-- Dashed path using stroke-dasharray (matching LaneSvg values) -->
<path
  d={path.d}
  fill="none"
  stroke={laneColor(path.colorIndex)}
  stroke-width={WIP_STROKE}
  stroke-dasharray="1 4"
  stroke-dashoffset="-3"
  stroke-linecap="round"
/>
```

### SVG Square Dot for Stash

```svelte
<!-- Square dot using <rect> centered on (cx, cy) -->
<rect
  x={dotCx - DOT_RADIUS}
  y={dotCy - DOT_RADIUS}
  width={DOT_RADIUS * 2}
  height={DOT_RADIUS * 2}
  fill={laneColor(commit.color_index)}
/>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-row SVG (LaneSvg) | ViewBox-clipped continuous paths (GraphCell) | Phase 15-16 (v0.4) | Eliminates row-boundary seams |
| Sentinel fallback to LaneSvg | Must be unified into GraphCell | Phase 17 (this phase) | Removes dual rendering path |

**Still valid from LaneSvg:**
- WIP stroke width: `WIP_STROKE = 1.5`
- Dash pattern: `stroke-dasharray="1 4"`, `stroke-dashoffset="-3"`
- WIP dot: hollow dashed circle
- Stash dots are NOT currently rendered in the graph (sidebar only)

## Key Design Decision: Stash Row Injection Strategy

Stash entries currently live only in `BranchSidebar.svelte` (loaded via `list_stashes` command). To render them in the commit graph, the stash data must be available in `CommitGraph.svelte`. Options:

1. **Pass stash entries as props to CommitGraph** (recommended) — `App.svelte` already connects sidebar refresh to graph refresh. Add a `stashes` prop from the refs data.
2. **Load stashes independently in CommitGraph** — Adds a separate API call; duplicates data already available from refs.
3. **Include stashes in Rust graph walk** — Wrong layer; stashes aren't revwalk commits.

**Recommendation:** Option 1. The `BranchSidebar` already loads `RefsResponse` which includes `stashes: StashEntry[]`. Thread this data to `CommitGraph` as a prop.

Stash row placement: Each stash has `parent_oid`. Insert stash synthetic rows immediately after the commit whose `oid` matches `stash.parent_oid`. If parent commit isn't in the loaded page, place the stash at the top (like WIP). Multiple stashes on the same parent should be grouped together.

## Open Questions

1. **Stash data availability in CommitGraph**
   - What we know: `BranchSidebar` loads `RefsResponse.stashes` which has `StashEntry[]` with `parent_oid`
   - What's unclear: Whether to thread stash data through App.svelte props or make CommitGraph load it independently
   - Recommendation: Thread via props from App.svelte's existing refs data, or load stashes directly in CommitGraph alongside the graph data fetch

2. **Stash dot shape — filled or hollow square?**
   - What we know: Success criteria says "square dots" for stash; LaneSvg does NOT currently render stash dots (no precedent)
   - What's unclear: Whether filled or hollow square, and what color
   - Recommendation: Filled square in lane color (simplest, most visible), matching how regular commits are filled circles

3. **Multiple stashes on the same parent commit**
   - What we know: Git allows unlimited stashes; they stack with indices 0, 1, 2, ...
   - What's unclear: How they should be ordered when injected
   - Recommendation: Insert in index order (0 first, then 1, etc.) immediately after their parent

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | `vite.config.ts` (test block) |
| Quick run command | `npx vitest --run` |
| Full suite command | `npx vitest --run --reporter=verbose` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SYNTH-01 | WIP row generates dashed connector path in computeGraphSvgData | unit | `npx vitest --run -t "WIP" -x` | ❌ Wave 0 |
| SYNTH-01 | WIP path has dashed:true flag | unit | `npx vitest --run -t "WIP.*dashed" -x` | ❌ Wave 0 |
| SYNTH-01 | WIP connector path d-string matches expected coordinates | unit | `npx vitest --run -t "WIP.*connector" -x` | ❌ Wave 0 |
| SYNTH-02 | Stash row generates dashed connector path | unit | `npx vitest --run -t "stash.*path" -x` | ❌ Wave 0 |
| SYNTH-02 | Stash path has dashed:true flag | unit | `npx vitest --run -t "stash.*dashed" -x` | ❌ Wave 0 |
| SYNTH-01/02 | Existing non-sentinel tests still pass (no regressions) | unit | `npx vitest --run -x` | ✅ (17 tests) |

### Sampling Rate
- **Per task commit:** `npx vitest --run`
- **Per wave merge:** `npx vitest --run --reporter=verbose`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] New test cases in `src/lib/graph-svg-data.test.ts` — WIP generates connector path with dashed flag
- [ ] New test cases in `src/lib/graph-svg-data.test.ts` — stash generates connector path with dashed flag
- [ ] New test cases in `src/lib/graph-svg-data.test.ts` — sentinel paths use correct key format
- [ ] Update existing "skips sentinel" tests to verify paths ARE generated (not skipped)

## Sources

### Primary (HIGH confidence)
- `src/components/LaneSvg.svelte` — current WIP rendering (dashed line, hollow dashed circle, stroke values)
- `src/lib/graph-svg-data.ts` — current sentinel skip logic, path generation patterns
- `src/components/GraphCell.svelte` — current viewBox-clipped rendering, context consumption
- `src/components/CommitRow.svelte` — current sentinel routing logic
- `src/components/CommitGraph.svelte` — current WIP item factory, displayItems composition
- `src/lib/types.ts` — SvgPathData interface, GraphCommit interface, StashEntry interface
- `src/lib/graph-constants.ts` — WIP_STROKE=1.5, DOT_RADIUS=6, LANE_WIDTH=12, ROW_HEIGHT=26

### Secondary (MEDIUM confidence)
- `.planning/phases/16-core-graph-rendering/16-01-SUMMARY.md` — sentinel routing pattern documentation
- `.planning/phases/15-graph-data-engine/15-01-SUMMARY.md` — sentinel filtering decision

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, all existing code examined directly
- Architecture: HIGH — extension of proven Phase 15/16 patterns; exact reference implementation in LaneSvg
- Pitfalls: HIGH — all identified from direct code analysis of viewBox clipping model and rendering pipeline

**Research date:** 2026-03-13
**Valid until:** 2026-04-13 (stable — internal architecture, no external dependencies)
