# Phase 9: WIP Row + Visual Polish - Research

**Researched:** 2026-03-09
**Domain:** SVG rendering, Svelte 5 virtual list integration, commit graph visual differentiation
**Confidence:** HIGH

## Summary

This phase adds two visual features to the commit graph: (1) merge commits render as hollow circles instead of filled circles, and (2) the WIP row moves inside the virtual list and connects to HEAD via a dashed line. Both features are frontend-only -- the backend already provides all necessary data (`is_merge`, `color_index`, `is_head`, `is_branch_tip`).

The merge commit hollow dot is a straightforward SVG change in `LaneSvg.svelte` -- swapping `fill` for `stroke` + background fill conditionally on `commit.is_merge`. The WIP row integration into the virtual list is the more complex task, requiring a synthetic `GraphCommit`-shaped object to be prepended to the `commits` array, with `CommitRow` (or `LaneSvg`) rendering the dashed connector line and dashed dot when it detects the WIP item.

**Primary recommendation:** Implement merge dot styling first (isolated, zero-risk change to `LaneSvg.svelte`), then tackle WIP row integration into the virtual list (requires coordination between `CommitGraph.svelte`, `CommitRow.svelte`, and `LaneSvg.svelte`).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- WIP row connection: Minimal connector only -- dashed line from WIP dot to HEAD, no full lane rails for other active branches
- Dashed line uses HEAD's lane color (color_index 0)
- WIP dot rendered as a dashed/dotted circle outline, matching the dashed connector line style
- WIP row moves inside the virtual list as the first item (not a separate div above) -- scrolls with commits, dashed line flows seamlessly into HEAD's row below
- Merge commit dot style: Hollow circle with lane-colored stroke (2px stroke width)
- Inner fill uses background color (--color-bg) -- rail line hidden inside the circle, looks like a clean ring
- Same size as regular dots (r=4) -- hollow styling alone distinguishes them
- `is_merge` already available in GraphCommit from Rust backend
- No reduced opacity anywhere -- VIS-03 intentionally not implemented as opacity reduction
- Merge commit text rendered identically to regular commits (same color, same opacity)
- The hollow dot is the sole visual differentiator for merge commits

### Claude's Discretion
- Dash pattern for WIP line and dot (e.g., stroke-dasharray values)
- How to inject WIP as first virtual list item (synthetic GraphCommit or separate mechanism)
- SVG layering adjustments needed for hollow dot + background fill rendering order

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| VIS-01 | User can visually distinguish merge commits from regular commits (hollow circle with lane-colored stroke) | `is_merge` boolean already in `GraphCommit` struct (Rust) and TS type. LaneSvg Layer 3 circle element needs conditional rendering based on `commit.is_merge`. Use `fill="var(--color-bg)"` + `stroke={laneColor(commit.color_index)}` + `stroke-width={2}` |
| VIS-02 | User sees a dashed lane line connecting the WIP row to the HEAD commit | WIP row currently rendered as separate div above virtual list (CommitGraph.svelte lines 125-144). Must be refactored to prepend a synthetic WIP entry to `commits` array. Dashed vertical line from WIP dot (cy) to bottom of row (rowHeight+0.5) using `stroke-dasharray` |
| VIS-03 | User sees merge commits rendered with reduced opacity to focus on actual work commits | **Per user decision: VIS-03 is satisfied by the hollow dot alone, NOT by opacity reduction.** The hollow circle styling from VIS-01 IS the visual de-emphasis. No opacity changes needed. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | ^5.0.0 | Component framework | Already in use; `$props()`, `$derived()`, `$state()` runes throughout |
| @humanspeak/svelte-virtual-list | ^0.4.2 | Virtual scrolling | Already in use; accepts `items` array and `renderItem` snippet |
| SVG (inline) | N/A | Graph rendering | Per-row inline SVG is the established pattern; no external SVG library needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tailwind CSS | ^4.2.1 | Utility styling | Already in use via `@tailwindcss/vite`; utility classes for layout |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Synthetic GraphCommit for WIP | Separate `wipItem` slot in virtual list | Virtual list has no header/slot API -- must use items array |
| CSS opacity for merge de-emphasis | Hollow dot only | User explicitly decided hollow dot alone; no opacity |

## Architecture Patterns

### Current Component Hierarchy
```
App.svelte
  -> CommitGraph.svelte (manages commits array, virtual list, WIP row)
       -> SvelteVirtualList (virtualizes commit rendering)
            -> CommitRow.svelte (per-commit row)
                 -> LaneSvg.svelte (SVG lanes + dot)
                 -> RefPill.svelte (branch/tag labels)
```

### Pattern 1: Conditional SVG Dot Rendering (Merge vs Regular)
**What:** LaneSvg Layer 3 circle element checks `commit.is_merge` to choose between filled and hollow rendering.
**When to use:** Every commit row render.
**Example:**
```svelte
<!-- Layer 3: Commit dot (top) -->
{#if commit.is_merge}
  <!-- Hollow circle: background fill hides rail line, colored stroke ring -->
  <circle
    cx={cx(commit.column)}
    cy={cy}
    r={4}
    fill="var(--color-bg)"
    stroke={laneColor(commit.color_index)}
    stroke-width={2}
  />
{:else}
  <!-- Filled circle -->
  <circle
    cx={cx(commit.column)}
    cy={cy}
    r={4}
    fill={laneColor(commit.color_index)}
  />
{/if}
```

### Pattern 2: Synthetic WIP Item in Virtual List
**What:** Create a synthetic object matching `GraphCommit` shape, prepended to `commits` array when `wipCount > 0`. The WIP item has a special marker (e.g., `oid: '__wip__'`) that `CommitRow` and `LaneSvg` check.
**When to use:** When worktree has uncommitted changes (`wipCount > 0`).
**Key considerations:**
- The synthetic WIP item must have `column: 0` and `color_index: 0` (HEAD lane)
- It needs edges: a single `Straight` edge from column 0 to column 0 so LaneSvg draws the dashed connector
- `scrollToHead` index calculation shifts by +1 when WIP item is present
- Virtual list `onLoadMore` offset math is unaffected (WIP is local, not from backend)

```typescript
function makeWipItem(maxColumns: number, wipMessage: string): GraphCommit {
  return {
    oid: '__wip__',
    short_oid: '',
    summary: wipMessage,
    body: null,
    author_name: '',
    author_email: '',
    author_timestamp: 0,
    parent_oids: [],
    column: 0,
    color_index: 0,
    edges: [{
      from_column: 0,
      to_column: 0,
      edge_type: 'Straight' as const,
      color_index: 0,
    }],
    refs: [],
    is_head: false,
    is_merge: false,
    is_branch_tip: false,
  };
}
```

### Pattern 3: WIP-Specific SVG Rendering in LaneSvg
**What:** When the commit is a WIP item, LaneSvg renders dashed elements instead of solid ones.
**When to use:** Only for the synthetic WIP commit.
**Detection:** Check `commit.oid === '__wip__'` or add an `is_wip?: boolean` field.

```svelte
<!-- WIP: dashed rail line -->
<line
  x1={cx(0)} y1={cy} x2={cx(0)} y2={rowHeight + 0.5}
  stroke={laneColor(0)}
  stroke-width={2.5}
  stroke-dasharray="4 3"
  stroke-linecap="round"
/>
<!-- WIP: dashed circle -->
<circle
  cx={cx(0)} cy={cy} r={4}
  fill="none"
  stroke={laneColor(0)}
  stroke-width={2}
  stroke-dasharray="3 2"
/>
```

### Anti-Patterns to Avoid
- **Adding a separate div for WIP outside virtual list:** Creates a visual seam -- the dashed line cannot flow into the first commit row's SVG seamlessly when they are separate DOM containers. Must be inside the virtual list.
- **Modifying Rust backend for WIP:** WIP is a client-side concept; the backend only returns real commits. Adding WIP synthetically on the frontend keeps concerns separated.
- **Using opacity for VIS-03:** User explicitly decided against opacity. Hollow dot is the sole differentiator.
- **Checking `is_wip` by adding a new Rust field:** WIP is frontend-only. Either use a sentinel `oid` value or add `is_wip` only to the TypeScript type.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Virtual scrolling with WIP header | Custom scroll container with fixed WIP row + scrolling body | Prepend WIP to `items` array in existing `SvelteVirtualList` | The existing virtual list already handles all scrolling concerns; fighting it with a fixed header creates scroll position bugs |
| SVG dash patterns | Custom path segments mimicking dashes | `stroke-dasharray` SVG attribute | Native SVG feature, hardware-accelerated, pixel-perfect |

## Common Pitfalls

### Pitfall 1: Virtual List Index Shift When WIP Present
**What goes wrong:** When WIP is prepended to `commits`, all commit indices shift by +1. The `scrollToHead` logic finds HEAD by index and scrolls to it -- this index is now off by one.
**Why it happens:** The synthetic WIP item occupies index 0; HEAD moves to index 1 (or wherever it was + 1).
**How to avoid:** After prepending WIP, adjust `scrollToHead` logic: `headIdx` from `findIndex` already accounts for it since it searches the modified array. But verify: if WIP is conditionally added/removed (dirty state changes), ensure the scroll target updates.
**Warning signs:** Graph scrolls to WIP row instead of HEAD on initial load.

### Pitfall 2: Sub-Pixel Gap Between WIP Row and HEAD Row
**What goes wrong:** A visible gap or misalignment between the WIP dashed line's bottom endpoint and the HEAD row's rail line top endpoint.
**Why it happens:** WIP row SVG draws its dashed line to `rowHeight + 0.5`, but if the virtual list adds any margin/padding between items, the 0.5px overlap trick fails.
**How to avoid:** Use the same `overflow: visible` and +0.5px overlap pattern already established for regular commit rows. Verify that `SvelteVirtualList` does not add item wrappers with padding.
**Warning signs:** A 1px horizontal gap between WIP and HEAD rows when scrolling.

### Pitfall 3: Hollow Dot Background Color Mismatch
**What goes wrong:** The merge commit hollow dot's `fill="var(--color-bg)"` doesn't match the actual row background when hovering (hover state changes background to `var(--color-surface)`).
**Why it happens:** The dot fill is hardcoded to `--color-bg` but the row background changes on hover.
**How to avoid:** Accept this as a minor visual artifact -- the 4px circle is tiny enough that the mismatch on hover is barely visible. Alternatively, use `fill="transparent"` but this exposes the rail line running through the dot center.
**Recommended approach:** Use `fill="var(--color-bg)"` as specified. The rail line visibility through a transparent fill is worse than the hover mismatch.

### Pitfall 4: WIP Row Pass-Through Edges for Other Active Lanes
**What goes wrong:** The WIP synthetic commit only has one edge (column 0 straight). Other active branch lanes that should pass through every row will have a gap in the WIP row.
**Why it happens:** Real commits get pass-through edges from the Rust lane algorithm; the WIP item is synthetic and doesn't participate.
**How to avoid:** Per the user decision, WIP has "minimal connector only -- no full lane rails for other active branches." This is intentional -- other lanes simply don't appear in the WIP row. The visual result is acceptable because the WIP row is the topmost row and branch lanes start at their tip commits below it.
**Warning signs:** None expected -- this is by design.

### Pitfall 5: WIP Item Breaks oncommitselect Callback
**What goes wrong:** Clicking the WIP row triggers `oncommitselect` with oid `'__wip__'`, which the parent tries to fetch as a real commit and fails.
**Why it happens:** `CommitRow` has an `onclick` that calls `onselect?.(commit.oid)`.
**How to avoid:** WIP row should call `onWipClick` instead of `oncommitselect`. Detect WIP in `CommitRow` (via oid sentinel) and route the click differently, or handle the `'__wip__'` oid in `CommitGraph` before passing to parent.

## Code Examples

### Current LaneSvg Layer 3 (to be modified)
```svelte
<!-- Current: always filled -->
<circle cx={cx(commit.column)} cy={cy} r={4} fill={laneColor(commit.color_index)} />
```

### Target: Conditional Merge Dot
```svelte
<!-- After: conditional hollow for merge commits -->
{#if commit.is_merge}
  <circle
    cx={cx(commit.column)} cy={cy} r={4}
    fill="var(--color-bg)"
    stroke={laneColor(commit.color_index)}
    stroke-width={2}
  />
{:else}
  <circle cx={cx(commit.column)} cy={cy} r={4} fill={laneColor(commit.color_index)} />
{/if}
```

### WIP Row Inside Virtual List (CommitGraph.svelte)
```typescript
// Build display items: WIP + real commits
const displayItems = $derived(
  wipCount > 0
    ? [makeWipItem(maxColumns, wipMessage), ...commits]
    : commits
);

// In template: pass displayItems to virtual list
// <SvelteVirtualList items={displayItems} ...>
```

### WIP Detection in LaneSvg
```svelte
<!-- Layer 1 override for WIP: dashed straight line from dot to bottom only -->
{#if commit.oid === '__wip__'}
  <line
    x1={cx(0)} y1={cy} x2={cx(0)} y2={rowHeight + 0.5}
    stroke={laneColor(0)}
    stroke-width={2.5}
    stroke-dasharray="4 3"
    stroke-linecap="round"
  />
{:else}
  {#each straightEdges as edge}
    <!-- existing straight edge rendering -->
  {/each}
{/if}
```

### WIP Dashed Dot in LaneSvg
```svelte
<!-- Layer 3 override for WIP: dashed circle -->
{#if commit.oid === '__wip__'}
  <circle
    cx={cx(0)} cy={cy} r={4}
    fill="none"
    stroke={laneColor(0)}
    stroke-width={2}
    stroke-dasharray="3 2"
  />
{:else if commit.is_merge}
  <!-- hollow circle -->
{:else}
  <!-- filled circle -->
{/if}
```

### Recommended stroke-dasharray Values
```
WIP connector line: stroke-dasharray="4 3"  (4px dash, 3px gap -- visible rhythm)
WIP circle (r=4):   stroke-dasharray="3 2"  (shorter dashes fit small circumference)
```
The WIP circle circumference is ~25px (2 * pi * 4). With `3 2` pattern, you get ~5 dashes around the circle, giving a clear "dotted" appearance. Match this rhythm with the line pattern `4 3` for visual cohesion -- both have a ~57% fill ratio.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| WIP as separate div above virtual list | WIP as first item inside virtual list | Phase 9 | Seamless dashed line connection, scrolls with content |
| All dots filled circles | Merge dots hollow, WIP dots dashed | Phase 9 | Visual hierarchy in commit graph |
| Opacity reduction for merge de-emphasis | Hollow dot styling only | Phase 9 context decision | Simpler, no readability loss on merge commit text |

## Open Questions

1. **WIP item reactivity when dirty state changes mid-session**
   - What we know: `wipCount` updates via `repo-changed` event -> `loadDirtyCounts()` -> `refresh()`. The `displayItems` derived value will reactively update when `wipCount` changes.
   - What's unclear: Does toggling WIP item presence (prepend/remove from array) cause the virtual list to lose scroll position?
   - Recommendation: Test manually. If scroll jumps, consider always including WIP item but hiding it visually when `wipCount === 0`.

2. **SVG dash pattern appearance at small circle radius**
   - What we know: `stroke-dasharray="3 2"` on a circle with r=4 gives ~5 dashes.
   - What's unclear: Whether the visual result looks good at various zoom levels.
   - Recommendation: Start with `3 2`, adjust during visual testing. The dash values can be tuned without architectural changes.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust `#[test]` (backend), no frontend test framework |
| Config file | `src-tauri/Cargo.toml` (Rust tests) |
| Quick run command | `cd src-tauri && cargo test --lib` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VIS-01 | Merge commits display hollow circle | manual-only | N/A -- SVG rendering is visual, no Rust logic changes | N/A |
| VIS-02 | WIP row connects to HEAD via dashed line | manual-only | N/A -- frontend-only, visual rendering | N/A |
| VIS-03 | Merge commits visually de-emphasized (hollow dot) | manual-only | N/A -- same as VIS-01, visual appearance | N/A |

**Manual-only justification:** All three requirements are purely visual SVG rendering changes in Svelte components. No Rust backend logic changes needed. There is no frontend test framework (no vitest/jest/playwright). The existing Rust tests already verify `is_merge` flag correctness (see `is_merge_flag` test in `graph.rs`). Validation is through visual inspection in the running app.

### Sampling Rate
- **Per task commit:** Visual inspection in dev server (`npm run tauri dev`)
- **Per wave merge:** `cd src-tauri && cargo test` (ensure no regressions)
- **Phase gate:** Visual verification of all three requirements against success criteria

### Wave 0 Gaps
None -- this phase has no backend changes requiring new tests. The `is_merge` flag is already tested. Frontend changes are visual-only and validated by manual inspection. No test framework setup needed.

## Sources

### Primary (HIGH confidence)
- **Project source code** (direct read): `LaneSvg.svelte`, `CommitGraph.svelte`, `CommitRow.svelte`, `App.svelte`, `graph.rs`, `types.ts`, `types.rs` -- complete understanding of current rendering pipeline
- **@humanspeak/svelte-virtual-list types** (direct read): `SvelteVirtualList.svelte.d.ts`, `types.d.ts` -- confirms `items` array approach, `renderItem` snippet, no header slot API

### Secondary (MEDIUM confidence)
- **SVG stroke-dasharray** -- standard SVG attribute, well-documented in SVG spec. Dash/gap pattern interpretation is consistent across all browsers.

### Tertiary (LOW confidence)
- **Dash pattern aesthetic values** (`3 2` for circle, `4 3` for line) -- these are recommendations based on circle circumference math; actual appearance needs visual validation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in use, no new dependencies
- Architecture: HIGH - Patterns follow existing codebase conventions exactly
- Pitfalls: HIGH - Identified from direct code reading, not speculation
- Dash pattern values: LOW - Aesthetic judgment, needs visual testing

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable -- no external dependencies changing)
