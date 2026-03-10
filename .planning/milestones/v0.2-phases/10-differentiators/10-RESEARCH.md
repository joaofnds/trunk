# Phase 10: Differentiators - Research

**Researched:** 2026-03-09
**Domain:** Svelte 5 component layout, CSS grid/flex column resizing, Rust DTO extension, Tauri LazyStore persistence
**Confidence:** HIGH

## Summary

Phase 10 adds two differentiator features: (1) lane-colored ref pills with connector lines, and (2) a resizable spreadsheet-style column layout with persistent widths. Both features build on well-established patterns already in the codebase -- the lane color palette, the RefPill component, the mousedown/mousemove/mouseup resize pattern in App.svelte, and the LazyStore persistence in store.ts.

The primary challenge is transforming CommitRow from a simple 3-section flex layout (refs | graph | message) into a 6-column layout (branch/tag | graph | commit message | author | date | sha) with a frozen header row. This requires structural changes to CommitGraph.svelte (adding a header above the virtual list) and CommitRow.svelte (expanding to 6 columns with widths driven by props). The ref pill coloring requires a backend change: adding `color_index` to `RefLabel` in Rust types and populating it from the commit's `color_index` during graph walk output assembly.

**Primary recommendation:** Implement in two waves -- (1) backend `color_index` on RefLabel + pill coloring + connector line, then (2) column header layout + resize handles + persistence. The first is a narrow vertical slice; the second is a layout refactor that touches CommitGraph, CommitRow, and store.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Ref pill coloring: Full background fill with lane color, white text on top (GitKraken-style)
- Tags use same lane color as their commit's lane (distinguished by icon/prefix only, not color)
- Remote refs shown but dimmed (reduced opacity) -- ONLY when remote-only; if a local ref exists on the same commit, the remote pill stays full opacity
- Overflow behavior unchanged: show first pill + "+N" count for additional refs
- Connector line: Horizontal line from ref pill right edge directly to the commit dot, using the lane color
- Connector line stays on the same row as the pill and dot
- Connector lines are contained within the graph column (graph column includes connector space)
- Pill component itself stays as-is -- no structural changes to RefPill beyond adding lane color
- Fixed header row with column labels: branch/tag | graph | commit message | author | date | sha
- Header is always visible (like a spreadsheet frozen header row)
- All six columns independently resizable via drag handles in the header
- Resize handles between column header borders
- Branch/tag column: fixed 120px default (resizable via header)
- Graph column: includes SVG lanes + connector line space; SVG keeps natural width, extra space is padding; min-width to prevent clipping
- Commit message column: flex-fills remaining space
- Column widths persist globally across repos using LazyStore pattern
- Same approach as existing left/right pane width persistence in store.ts

### Claude's Discretion
- Resize handle visual style (thin divider, hover effect, cursor)
- Initial default widths for author, date, sha columns
- Min/max width constraints per column
- How connector line renders in SVG (part of LaneSvg or separate element)
- Header row styling (height, font, background color)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DIFF-01 | User sees branch/tag ref pills colored to match their lane color | Requires adding `color_index` to `RefLabel` in Rust types.rs and graph.rs output assembly, mirroring in TS types.ts, then using `var(--lane-N)` as pill background in RefPill.svelte. Connector line drawn in LaneSvg.svelte from pill edge to commit dot. |
| DIFF-02 | User can resize the graph column width via drag handle | Requires header row above SvelteVirtualList in CommitGraph.svelte, CommitRow.svelte expanded to 6-column layout with width props, mousedown/mousemove/mouseup resize pattern (copy from App.svelte), LazyStore persistence for column widths (copy from store.ts pane width pattern). |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | ^5.0.0 | UI framework (runes, $state, $derived, $props) | Already in use; all components use Svelte 5 runes |
| Tailwind CSS | ^4.2.1 | Utility-first styling | Already in use; via @tailwindcss/vite plugin |
| @tauri-apps/plugin-store | ^2.4.2 | LazyStore for persistent settings | Already in use for pane widths and recent repos |
| @humanspeak/svelte-virtual-list | ^0.4.2 | Virtual scrolling for commit list | Already in use in CommitGraph.svelte |
| git2 (Rust) | via Cargo | Git operations backend | Already in use for graph walking |

### Supporting
No new libraries needed. All features build on existing stack.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual mousedown/mousemove resize | CSS `resize` property | CSS resize only works on block elements, not column headers; no persistence hook |
| Inline style widths | CSS Grid `grid-template-columns` | Grid would be cleaner but harder to integrate with virtual list where each row is independent |

## Architecture Patterns

### Current Project Structure (relevant files)
```
src/
  components/
    RefPill.svelte          # Ref pill display (needs lane color prop)
    LaneSvg.svelte          # Per-row SVG (needs connector line)
    CommitRow.svelte        # Row layout (needs 6-column expansion)
    CommitGraph.svelte      # Virtual list wrapper (needs header row)
  lib/
    types.ts                # TS interfaces mirroring Rust DTOs
    store.ts                # LazyStore persistence (add column widths)
  app.css                   # CSS variables including --lane-0..7
src-tauri/src/
  git/
    types.rs                # Rust DTOs (RefLabel needs color_index)
    graph.rs                # Graph walk (populate RefLabel.color_index)
    repository.rs           # build_ref_map (RefLabel construction)
```

### Pattern 1: Lane Color Mapping
**What:** The `laneColor()` function in LaneSvg.svelte maps a `color_index` to `var(--lane-${idx % 8})`. This same function must be reused (or extracted) to color ref pills.
**When to use:** Any time a UI element needs to match its lane color.
**Current code (LaneSvg.svelte line 15):**
```typescript
const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
```
**Integration:** RefPill needs access to `color_index` from the commit. Since RefPill receives `refs: RefLabel[]`, the most direct approach is adding `color_index` to `RefLabel` itself. The commit's `color_index` is already available in `GraphCommit` -- during Rust output assembly (graph.rs line 262-281), each commit's refs are attached. The `color_index` from the commit can be copied to each RefLabel at that point.

### Pattern 2: Resize Handle (mousedown/mousemove/mouseup)
**What:** The existing App.svelte uses a well-tested pattern for draggable resize handles.
**When to use:** Column width resizing in the header row.
**Current code (App.svelte lines 218-241):**
```typescript
function startLeftResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = leftPaneCollapsed ? 0 : leftPaneWidth;

  function onMouseMove(ev: MouseEvent) {
    const newWidth = Math.max(0, startWidth + ev.clientX - startX);
    // ... apply constraints
  }

  function onMouseUp() {
    setLeftPaneWidth(leftPaneWidth);  // persist on release
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}
```
**For columns:** Generalize to `startColumnResize(columnKey, e)` that captures startX, reads current width, updates width state on mousemove, persists on mouseup.

### Pattern 3: LazyStore Persistence
**What:** The store.ts file exports typed getter/setter pairs that wrap `store.get<T>(KEY)` / `store.set(KEY, value)` / `store.save()`.
**When to use:** Persisting column widths across sessions.
**Current code (store.ts lines 38-57):**
```typescript
const LEFT_PANE_KEY = 'left_pane_width';

export async function getLeftPaneWidth(): Promise<number> {
  return (await store.get<number>(LEFT_PANE_KEY)) ?? 220;
}

export async function setLeftPaneWidth(width: number): Promise<void> {
  await store.set(LEFT_PANE_KEY, width);
  await store.save();
}
```
**For columns:** Store a single object `{ ref: 120, graph: 120, message: -1, author: 120, date: 100, sha: 80 }` under one key, or individual keys per column. Single object approach is cleaner -- one read on init, one write on change.

### Pattern 4: Column Width Propagation
**What:** Column widths must be defined in CommitGraph (header owner) and passed to each CommitRow as props.
**When to use:** Ensuring header and rows share identical column widths.
**Architecture:**
```
CommitGraph.svelte
  ├── Header Row (reads/sets columnWidths state)
  │     └── Resize handles between columns
  └── SvelteVirtualList
        └── CommitRow (receives columnWidths as prop)
              ├── div[width=columnWidths.ref]   # RefPill
              ├── div[width=columnWidths.graph]  # LaneSvg + connector
              ├── div[flex=1]                    # Message
              ├── div[width=columnWidths.author] # Author
              ├── div[width=columnWidths.date]   # Date
              └── div[width=columnWidths.sha]    # SHA
```

### Pattern 5: Connector Line in SVG
**What:** A horizontal line from the right edge of the ref pill column to the commit dot.
**When to use:** Visually connecting ref pills to their commit in the graph.
**Architecture decision:** The connector line should be part of the graph column's SVG (LaneSvg). The line extends from x=0 (left edge of SVG, which is where the ref pill column ends) to the commit dot's cx. This keeps it inside the graph column as specified.
**Implementation:**
```svelte
<!-- In LaneSvg.svelte, only when commit has refs -->
{#if commit.refs.length > 0}
  <line
    x1={0}
    y1={cy}
    x2={cx(commit.column)}
    y2={cy}
    stroke={laneColor(commit.color_index)}
    stroke-width={1.5}
  />
{/if}
```

### Anti-Patterns to Avoid
- **Don't use CSS Grid for the row layout:** Each CommitRow is rendered independently inside a virtual list. CSS Grid on a parent can't span across virtual list items. Use inline style widths on flex children instead.
- **Don't persist widths on every mousemove:** Only call `store.set()` + `store.save()` on mouseup. The existing App.svelte pattern already does this correctly. Persisting on every pixel of drag would thrash disk I/O.
- **Don't modify RefPill structurally:** The user explicitly said "I didn't ask to change the pill itself." Only override the color via props; keep the existing shape, truncation, and overflow behavior.
- **Don't use a separate connector component:** The connector line is a simple SVG `<line>`. Adding a new component for it would be over-engineering.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Column width persistence | Custom localStorage wrapper | Existing LazyStore in store.ts | Already battle-tested, handles Tauri's file-backed store correctly |
| Drag resize interaction | Custom pointer capture system | mousedown/mousemove/mouseup pattern from App.svelte | Already working for pane resizing; proven approach |
| Virtual scrolling | Custom virtualization for 6-column layout | Existing SvelteVirtualList | Works with any row content; just update CommitRow contents |
| Lane color computation | Duplicate color logic | Extract laneColor() to shared utility | Currently inline in LaneSvg; used by both LaneSvg and RefPill |

## Common Pitfalls

### Pitfall 1: Column Width Mismatch Between Header and Rows
**What goes wrong:** Header columns and virtual list rows get out of sync, creating misaligned columns.
**Why it happens:** Header is a static element outside the virtual list. If widths are computed differently (e.g., rounding, borders, padding), columns drift.
**How to avoid:** Use a single `columnWidths` state object in CommitGraph. Pass it as a prop to both the header and each CommitRow. Use identical inline `style="width: {w}px"` for both. No borders/padding that differ between header and row cells.
**Warning signs:** Content appears shifted right/left compared to header labels.

### Pitfall 2: Remote Dimming Logic
**What goes wrong:** All remote refs get dimmed, even when they share a commit with a local ref.
**Why it happens:** Naive implementation checks `ref.ref_type === 'RemoteBranch'` without checking siblings.
**How to avoid:** When rendering refs for a commit, first check if ANY ref on that commit is a LocalBranch or Tag. If yes, remote refs on the same commit stay full opacity. Only dim remote refs when ALL refs on that commit are remote.
**Warning signs:** `origin/main` appears dimmed even when `main` is on the same commit.

### Pitfall 3: Graph Column Min-Width Clipping SVG
**What goes wrong:** User drags the graph column too narrow, clipping the SVG lanes.
**Why it happens:** No min-width constraint based on actual lane count.
**How to avoid:** Set graph column min-width to `maxColumns * laneWidth` (currently laneWidth=12). The SVG's natural width is `Math.max(maxColumns, column+1) * laneWidth`. Enforce this as the floor in the resize handler.
**Warning signs:** Lane lines and dots appear cut off on the right side.

### Pitfall 4: Connector Line Extending Beyond SVG Viewport
**What goes wrong:** The connector line from x=0 to the commit dot renders outside the SVG's viewBox or gets clipped.
**Why it happens:** SVG has `overflow: visible` already (set in Phase 8), so this is actually safe. But if the ref pill column is to the LEFT of the SVG, the line needs to start at x=0 of the SVG (its left edge) and extend to the dot.
**How to avoid:** The connector line starts at x=0 of the SVG and goes to `cx(commit.column)`. Since SVG already has `overflow: visible`, the line will render correctly even if the dot is at x=0 (column 0), making the line zero-length (which is fine -- no line needed when dot is at the left edge).
**Warning signs:** Connector line appears detached or extends into wrong area.

### Pitfall 5: Flex-1 Message Column Not Filling Remaining Space
**What goes wrong:** The message column doesn't flex to fill remaining space when other columns are resized.
**Why it happens:** Using a fixed width for the message column instead of flex.
**How to avoid:** All columns except message get explicit `width` via inline style. The message column uses `flex: 1` to absorb remaining space. This is the same pattern used currently in CommitRow.
**Warning signs:** Empty gap appears at the right of the row, or message column overlaps other columns.

### Pitfall 6: color_index Not Available for RefLabel in Rust
**What goes wrong:** RefLabels are built in `build_ref_map()` in repository.rs, which runs before lane assignment in graph.rs. At build time, color_index is unknown.
**Why it happens:** `build_ref_map` iterates git2 references and doesn't know about lane assignment.
**How to avoid:** Keep `RefLabel.color_index` as 0 initially. In graph.rs `walk_commits()` step 5 (line 262), after extracting `color_index` from `per_oid_data`, iterate over the commit's refs and set each ref's `color_index` to the commit's `color_index`. This requires making RefLabel fields mutable or cloning with modification.
**Warning signs:** All pills show the same color (color_index 0 = --lane-0).

## Code Examples

### Adding color_index to RefLabel (Rust)
```rust
// In types.rs: Add color_index field to RefLabel
#[derive(Debug, Serialize, Clone)]
pub struct RefLabel {
    pub name: String,
    pub short_name: String,
    pub ref_type: RefType,
    pub is_head: bool,
    pub color_index: usize,  // NEW: lane color for visual matching
}
```

```rust
// In repository.rs: Initialize color_index to 0 in build_ref_map
map.entry(oid).or_default().push(RefLabel {
    name,
    short_name,
    ref_type,
    is_head,
    color_index: 0,  // Will be set during graph walk
});
```

```rust
// In graph.rs: Set color_index on refs during output assembly (after line 262)
let mut refs = ref_map.get(&oid).cloned().unwrap_or_default();
for r in &mut refs {
    r.color_index = color_index;
}
```

### Updating TypeScript RefLabel interface
```typescript
// In types.ts
export interface RefLabel {
  name: string;
  short_name: string;
  ref_type: RefType;
  is_head: boolean;
  color_index: number;  // NEW: lane color index
}
```

### Lane-Colored RefPill (Svelte 5)
```svelte
<!-- RefPill.svelte: Add lane color via color_index prop -->
<script lang="ts">
  import type { RefLabel } from '../lib/types.js';

  interface Props {
    refs: RefLabel[];
    laneColorIndex?: number;  // from commit.color_index
  }

  let { refs, laneColorIndex = 0 }: Props = $props();

  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;

  function isRemoteOnly(ref: RefLabel, allRefs: RefLabel[]): boolean {
    if (ref.ref_type !== 'RemoteBranch') return false;
    return !allRefs.some(r => r.ref_type === 'LocalBranch' || r.ref_type === 'Tag');
  }
</script>

{#if refs.length > 0}
  {@const ref = refs[0]}
  <span
    class="inline-flex items-center rounded-full px-1.5 py-0 text-[11px] leading-5 whitespace-nowrap max-w-[100px] truncate font-medium"
    style="background: {laneColor(ref.color_index)}; color: white; {isRemoteOnly(ref, refs) ? 'opacity: 0.5;' : ''}"
  >
    {pillPrefix(ref)}{ref.short_name}
  </span>
  {#if refs.length > 1}
    <span class="text-[11px] text-[var(--color-text-muted)] ml-1 cursor-default"
      title={refs.slice(1).map((r) => r.short_name).join(', ')}>
      +{refs.length - 1}
    </span>
  {/if}
{/if}
```

### Column Width State and Persistence
```typescript
// In store.ts: Add column width persistence
export interface ColumnWidths {
  ref: number;
  graph: number;
  author: number;
  date: number;
  sha: number;
  // message is flex-1, no fixed width
}

const COLUMN_WIDTHS_KEY = 'column_widths';

const DEFAULT_WIDTHS: ColumnWidths = {
  ref: 120,
  graph: 120,
  author: 120,
  date: 100,
  sha: 80,
};

export async function getColumnWidths(): Promise<ColumnWidths> {
  return (await store.get<ColumnWidths>(COLUMN_WIDTHS_KEY)) ?? DEFAULT_WIDTHS;
}

export async function setColumnWidths(widths: ColumnWidths): Promise<void> {
  await store.set(COLUMN_WIDTHS_KEY, widths);
  await store.save();
}
```

### Header Row with Resize Handles
```svelte
<!-- In CommitGraph.svelte: Header row above virtual list -->
<div class="flex items-center" style="height: 24px; background: var(--color-surface); border-bottom: 1px solid var(--color-border); font-size: 11px; color: var(--color-text-muted); user-select: none;">
  <div style="width: {columnWidths.ref}px; padding-left: 8px;" class="flex-shrink-0 relative">
    Branch/Tag
    <div class="resize-handle" onmousedown={(e) => startColumnResize('ref', e)}></div>
  </div>
  <div style="width: {columnWidths.graph}px;" class="flex-shrink-0 relative">
    Graph
    <div class="resize-handle" onmousedown={(e) => startColumnResize('graph', e)}></div>
  </div>
  <div class="flex-1 relative" style="padding-left: 8px;">
    Message
    <div class="resize-handle" onmousedown={(e) => startColumnResize('message', e)}></div>
  </div>
  <div style="width: {columnWidths.author}px;" class="flex-shrink-0 relative">
    Author
    <div class="resize-handle" onmousedown={(e) => startColumnResize('author', e)}></div>
  </div>
  <div style="width: {columnWidths.date}px;" class="flex-shrink-0 relative">
    Date
    <div class="resize-handle" onmousedown={(e) => startColumnResize('date', e)}></div>
  </div>
  <div style="width: {columnWidths.sha}px;" class="flex-shrink-0 relative">
    SHA
  </div>
</div>
```

### Resize Handle CSS (copy pane-divider pattern)
```css
.resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  user-select: none;
}
.resize-handle:hover {
  background: var(--color-accent);
}
```

### Connector Line in LaneSvg
```svelte
<!-- In LaneSvg.svelte: Add connector line from left edge to commit dot -->
<!-- Render BELOW rails (Layer 0.5) but above nothing, between layer 1 and the left edge -->
{#if commit.refs.length > 0 && commit.oid !== '__wip__'}
  <line
    x1={0}
    y1={cy}
    x2={cx(commit.column)}
    y2={cy}
    stroke={laneColor(commit.color_index)}
    stroke-width={1.5}
    stroke-linecap="round"
  />
{/if}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CommitRow: 3-section flex (refs, graph, message) | Will become 6-column flex (refs, graph, message, author, date, sha) | This phase | Rows show more metadata at a glance |
| RefPill: type-based coloring (green for branch, accent for HEAD) | Will use lane color (commit's color_index maps to --lane-N) | This phase | Pills visually connect to their graph lane |
| No column headers | Fixed spreadsheet-style header row | This phase | Users understand layout and can resize columns |
| short_oid inline in message | Separate SHA column | This phase | Cleaner separation of concerns |

## Open Questions

1. **WIP row in 6-column layout**
   - What we know: WIP row currently uses `commit.oid === '__wip__'` sentinel with italic styling in CommitRow
   - What's unclear: Should WIP row span all 6 columns, or show empty author/date/sha?
   - Recommendation: Show WIP row with empty author, date, sha columns (they're blank for WIP). The ref pill column can show the WIP indicator if any, and the message column shows the italic WIP text. This matches the existing behavior, just expanded.

2. **Connector line when commit is at column 0**
   - What we know: `cx(0)` = `laneWidth/2` = 6px. The line would go from x=0 to x=6.
   - What's unclear: Is a 6px connector line visually useful or just noise?
   - Recommendation: Only render connector when `cx(commit.column) > laneWidth` (i.e., dot is not in the first column). A 6px line connecting to a dot right next to the pill is redundant.

3. **Graph column min-width calculation**
   - What we know: `maxColumns` is the high-water mark from the Rust backend. `laneWidth` is 12px.
   - What's unclear: Should the graph column min-width be `maxColumns * laneWidth`, or should there be extra padding for the connector line?
   - Recommendation: Min-width = `maxColumns * laneWidth`. The connector line starts at x=0 and extends into the SVG, which already has `overflow: visible`. No extra space needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust `#[cfg(test)]` for backend; no frontend test framework |
| Config file | Inline `#[cfg(test)] mod tests` in graph.rs |
| Quick run command | `cd src-tauri && cargo test --lib` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DIFF-01 | RefLabel includes color_index matching commit color | unit | `cd src-tauri && cargo test graph::tests::ref_label_color_index -x` | No -- Wave 0 |
| DIFF-01 | Pill renders with lane color background | manual-only | Visual inspection in running app | N/A |
| DIFF-01 | Remote-only refs dimmed, shared refs full opacity | manual-only | Visual inspection | N/A |
| DIFF-01 | Connector line from pill to dot | manual-only | Visual inspection | N/A |
| DIFF-02 | Column widths persist via LazyStore | manual-only | Visual: resize, reload, check preserved | N/A |
| DIFF-02 | Header row visible and aligned with rows | manual-only | Visual inspection | N/A |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test --lib`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** Full suite green + visual inspection of both features

### Wave 0 Gaps
- [ ] `graph::tests::ref_label_color_index` -- verify RefLabel.color_index matches commit color_index after graph walk
- [ ] `graph::tests::ref_label_color_index_no_refs` -- commits without refs should still work (no panic)

## Sources

### Primary (HIGH confidence)
- **Codebase inspection:** All findings from direct reading of source files:
  - `src/components/RefPill.svelte` -- current pill rendering (type-based colors, no lane color)
  - `src/components/LaneSvg.svelte` -- laneColor() function, SVG rendering, overflow:visible
  - `src/components/CommitRow.svelte` -- current 3-column flex layout
  - `src/components/CommitGraph.svelte` -- SvelteVirtualList integration, makeWipItem
  - `src/App.svelte` -- startLeftResize/startRightResize pattern, pane-divider CSS
  - `src/lib/store.ts` -- LazyStore pattern for persistence
  - `src/lib/types.ts` -- TypeScript DTOs (RefLabel lacks color_index)
  - `src/app.css` -- 8-color lane palette (--lane-0 through --lane-7)
  - `src-tauri/src/git/types.rs` -- Rust DTOs (RefLabel lacks color_index)
  - `src-tauri/src/git/graph.rs` -- walk_commits, output assembly at line 262-285
  - `src-tauri/src/git/repository.rs` -- build_ref_map constructs RefLabels

### Secondary (MEDIUM confidence)
- **CONTEXT.md code_context section** -- user-provided integration points confirmed by codebase reading

### Tertiary (LOW confidence)
- None -- all findings verified against source code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new dependencies
- Architecture: HIGH -- patterns copied directly from existing codebase (resize handlers, LazyStore, laneColor)
- Pitfalls: HIGH -- identified from direct code analysis of current implementation
- Rust backend change: HIGH -- straightforward field addition with clear integration point

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable codebase, no external dependency changes expected)
