# Phase 26: SVG Ref Pills - Research

**Researched:** 2026-03-14
**Domain:** SVG text rendering, pill layout computation, Canvas text measurement, overlay pipeline extension
**Confidence:** HIGH

## Summary

Phase 26 migrates ref pills from HTML elements inside `CommitRow.svelte` to SVG elements inside the graph overlay `<svg>`. This is the final and highest-risk piece of the v0.5 Graph Overlay architecture. The core challenge is that SVG `<text>` does not natively support CSS text-overflow/ellipsis or wrapping — all text measurement, truncation, and layout must be computed upfront in TypeScript before rendering.

The existing overlay pipeline (Phase 20-24) provides a proven pattern: compute data in `$derived`, filter by visible range in the overlay snippet, render as SVG elements in `<g>` groups. Phase 26 follows this exact pattern with a new data type (`OverlayRefPill`) computed from `GraphCommit.refs` and `OverlayNode` positions. The pill layer becomes the fourth `<g>` group (after rails, connections, dots).

The highest technical risk is SVG text measurement for truncation. The recommended approach is a cached `Canvas.measureText()` utility that pre-computes text widths for all visible pills. This avoids DOM-dependent `getComputedTextLength()` calls and works synchronously in the `$derived` computation. For the hover-expand interaction (GitKraken-style), an HTML overlay positioned above the SVG is the most reliable approach — SVG text layout lacks the flexibility for multi-line expanding pill rendering.

**Primary recommendation:** Build pill data computation as a pure TypeScript pipeline (`buildRefPillData()`), use Canvas `measureText()` for text truncation, render pills as SVG `<rect>` + `<text>` in a fourth `<g>` group, and use an HTML overlay for hover-expand interaction.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Overflow handling:** 1 pill + separate darkened +N badge (not inline count). On hover (pill or +N badge), pill expands to show all ref names, one per line — GitKraken style. Smooth expand animation (~150-200ms).
- **Pill display density:** 1 pill visible + overflow badge. Ref column stays at 120px default (still user-resizable). Long pill text truncated with ellipsis ("feature/long-b..."). HEAD branch gets first priority as the visible pill; other refs go to overflow.
- **Connector line appearance:** Straight horizontal SVG line from pill right edge to commit dot (no curve). Thickness matches EDGE_STROKE (1.5px). Connector uses commit's lane color (not the displayed ref's color). Connector inherits pill dimming rules: 65-70% opacity for remote-only, brightness(0.75) for non-HEAD.
- **Ref type visual distinctions:** Replace unicode prefixes (diamond, flag) with small SVG path icons for tags and stashes. Remote branch dimming: softer at 65-70% opacity (up from 50%). Non-HEAD branch darkening: keep brightness(0.75). Pill shape: capsule (fully rounded ends — rx/ry = half pill height).

### Claude's Discretion
- Hover expansion implementation (HTML overlay positioned over SVG vs pure SVG solution)
- SVG icon designs for tag and stash prefixes
- Exact pill padding, font size, and text positioning within SVG rect
- Text measurement approach for truncation (Canvas measureText or other)
- How ref pill data flows through the overlay pipeline (new type, visibility filtering)
- z-ordering of ref pill layer relative to rails/connections/dots

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PILL-01 | Ref pills render as SVG `<rect>` + `<text>` elements with lane-colored backgrounds | New `OverlayRefPill` type with x/y/width/height/label/colorIndex; render as `<rect rx={h/2}>` + `<text>` in fourth `<g>` group; laneColor() for fill |
| PILL-02 | SVG connector lines render from ref pill to commit dot | Horizontal `<line>` from pill right edge to `cx(node.x)` at `cy(node.y)`; commit's lane color; EDGE_STROKE width |
| PILL-03 | Remote branch pills appear visually dimmed compared to local branch pills | `opacity: 0.65-0.70` on remote-only pills and their connectors; `filter: brightness(0.75)` on non-HEAD local pills |
| PILL-04 | Overflow "+N" badge appears when refs exceed available space | When `refs.length > 1`, render a separate darkened +N badge SVG element; on hover, show HTML overlay expanding all refs |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte 5 | Current | Component framework with `$derived`, snippets | Already in use; overlay snippet renders SVG |
| SVG (browser native) | N/A | `<rect>`, `<text>`, `<line>`, `<g>` elements | Zero-dependency; CSS custom properties work in fill/stroke |
| Canvas 2D (browser native) | N/A | `measureText()` for text width computation | Synchronous, no DOM measurement needed |
| Vitest | 4.1.0 | Unit testing for pill data computation | Already in use for all overlay pipeline tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | — | — | All capabilities are browser primitives + existing patterns |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Canvas `measureText()` | SVG `getComputedTextLength()` | Requires element in DOM; async; can't use in `$derived` |
| Canvas `measureText()` | Approximate char-width table | Less accurate but zero allocation; may suffice for fixed-width fonts only |
| HTML overlay for hover-expand | Pure SVG `<foreignObject>` | foreignObject has browser inconsistencies and breaks pointer-events model |
| HTML overlay for hover-expand | Pure SVG multi-line text | SVG `<text>` has no native line wrapping; manual `<tspan>` positioning is fragile |

## Architecture Patterns

### Data Flow (Extended Pipeline)
```
GraphCommit[]
    ↓ buildGraphData() [Phase 21]
OverlayGraphData { nodes: OverlayNode[], edges: OverlayEdge[] }
    ↓ buildOverlayPaths() [Phase 22]
OverlayPath[]
    ↓ buildRefPillData() [Phase 26 — NEW]
OverlayRefPill[] { rowIndex, x, y, width, height, label, truncatedLabel, colorIndex, isHead, isRemoteOnly, isNonHead, refType, overflowCount, allRefs }
    ↓ getVisibleOverlayElements() [Phase 23 — EXTENDED]
{ rails, connections, dots, pills: OverlayRefPill[] }
    ↓ SVG rendering [Phase 23 extended]
<svg> → <g class="overlay-rails"> → <g class="overlay-connections"> → <g class="overlay-dots"> → <g class="overlay-pills">
```

### New Type: `OverlayRefPill`
```typescript
export interface OverlayRefPill {
  // Position (absolute SVG coordinates)
  x: number;          // left edge of pill in SVG space
  y: number;          // vertical center (same as cy(rowIndex))
  width: number;      // computed from text measurement + padding
  height: number;     // fixed (e.g. 20px)

  // Content
  label: string;          // original ref short_name
  truncatedLabel: string; // possibly truncated with "..."
  refType: RefType;       // 'LocalBranch' | 'RemoteBranch' | 'Tag' | 'Stash'

  // Styling
  colorIndex: number;     // for laneColor() lookup
  isHead: boolean;        // full brightness
  isRemoteOnly: boolean;  // 65-70% opacity dimming
  isNonHead: boolean;     // brightness(0.75)

  // Overflow
  overflowCount: number;  // 0 = no badge needed, >0 = "+N" badge
  allRefs: RefLabel[];    // all refs on this commit (for hover expansion)

  // Connector
  dotCx: number;          // target commit dot X coordinate
  dotCy: number;          // target commit dot Y coordinate (same as y)
  commitColorIndex: number; // commit's lane color for connector

  // Filtering
  rowIndex: number;       // for virtualization filtering
}
```

### Recommended Project Structure
```
src/
├── lib/
│   ├── types.ts                # Add OverlayRefPill interface
│   ├── ref-pill-data.ts        # NEW: buildRefPillData() — pure computation
│   ├── ref-pill-data.test.ts   # NEW: unit tests for pill computation
│   ├── text-measure.ts         # NEW: Canvas measureText() utility with caching
│   ├── text-measure.test.ts    # NEW: unit tests for text measurement
│   ├── overlay-visible.ts      # EXTEND: add pills filtering
│   ├── graph-constants.ts      # ADD: PILL_HEIGHT, PILL_PADDING_X, PILL_FONT_SIZE, PILL_GAP
│   └── active-lanes.ts         # (unchanged)
├── components/
│   ├── CommitGraph.svelte       # EXTEND: add pill layer to overlay snippet + hover overlay
│   ├── CommitRow.svelte         # MODIFY: remove HTML ref pills, connector div, +N badge
│   ├── RefPill.svelte           # REMOVE or keep as unused reference
│   └── VirtualList.svelte       # (unchanged)
```

### Pattern 1: Pill Data Computation (`buildRefPillData()`)
**What:** Pure function that transforms `OverlayNode[]` + `GraphCommit[]` into `OverlayRefPill[]`
**When to use:** Called in `$derived` after `buildGraphData()`, before rendering
**Example:**
```typescript
// Source: Established pattern from buildGraphData() / buildOverlayPaths()
export function buildRefPillData(
  nodes: OverlayNode[],
  commits: GraphCommit[],
  refColumnWidth: number,
  measureText: (text: string) => number,
): OverlayRefPill[] {
  const pills: OverlayRefPill[] = [];

  for (const node of nodes) {
    if (node.isWip || node.isStash) continue;
    const commit = commits[node.y];
    if (!commit || commit.refs.length === 0) continue;

    // Sort refs: HEAD first, then local branches, then tags, then remotes
    const sorted = sortRefs(commit.refs);
    const primaryRef = sorted[0];
    const overflowCount = sorted.length - 1;

    // Measure and truncate text
    const maxTextWidth = refColumnWidth - PILL_PADDING_X * 2 - ICON_WIDTH - BADGE_RESERVED;
    const { truncated, width: textWidth } = truncateText(
      primaryRef.short_name, maxTextWidth, measureText
    );

    const pillWidth = textWidth + PILL_PADDING_X * 2 + ICON_WIDTH;
    const pillX = PILL_MARGIN_LEFT; // left edge within ref column area
    const pillY = cy(node.y);       // vertically centered in row

    pills.push({
      rowIndex: node.y,
      x: pillX,
      y: pillY,
      width: pillWidth,
      height: PILL_HEIGHT,
      label: primaryRef.short_name,
      truncatedLabel: truncated,
      refType: primaryRef.ref_type,
      colorIndex: primaryRef.color_index,
      isHead: primaryRef.is_head,
      isRemoteOnly: isRemoteOnlyRef(primaryRef, sorted),
      isNonHead: !primaryRef.is_head,
      overflowCount,
      allRefs: sorted,
      dotCx: cx(node.x),
      dotCy: pillY,
      commitColorIndex: node.colorIndex,
    });
  }

  return pills;
}
```

### Pattern 2: Canvas Text Measurement Utility
**What:** Cached text width measurement using off-screen Canvas
**When to use:** Synchronous text measurement needed in `$derived` computation
**Example:**
```typescript
// Source: Browser Canvas 2D API (MDN docs)
let _ctx: CanvasRenderingContext2D | null = null;

function getTextContext(font: string): CanvasRenderingContext2D {
  if (!_ctx) {
    const canvas = document.createElement('canvas');
    _ctx = canvas.getContext('2d')!;
  }
  _ctx.font = font;
  return _ctx;
}

const _cache = new Map<string, number>();

export function measureTextWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  let width = _cache.get(key);
  if (width === undefined) {
    width = getTextContext(font).measureText(text).width;
    _cache.set(key, width);
  }
  return width;
}

export function truncateWithEllipsis(
  text: string,
  maxWidth: number,
  font: string,
): { text: string; width: number } {
  const fullWidth = measureTextWidth(text, font);
  if (fullWidth <= maxWidth) return { text, width: fullWidth };

  const ellipsis = '\u2026'; // "..."
  const ellipsisWidth = measureTextWidth(ellipsis, font);
  let truncated = text;

  while (truncated.length > 1) {
    truncated = truncated.slice(0, -1);
    const w = measureTextWidth(truncated, font) + ellipsisWidth;
    if (w <= maxWidth) {
      return { text: truncated + ellipsis, width: w };
    }
  }

  return { text: ellipsis, width: ellipsisWidth };
}
```

### Pattern 3: SVG Pill Rendering (Fourth `<g>` Group)
**What:** SVG rendering of capsule-shaped ref pills with text and connector lines
**When to use:** Inside the overlay snippet in CommitGraph.svelte
**Example:**
```svelte
<!-- Source: Established three-layer pattern in CommitGraph.svelte -->
<g class="overlay-pills">
  {#each visible.pills as pill}
    <!-- Connector line: pill right edge to commit dot -->
    <line
      x1={pill.x + pill.width}
      y1={pill.y}
      x2={pill.dotCx}
      y2={pill.dotCy}
      stroke={laneColor(pill.commitColorIndex)}
      stroke-width={EDGE_STROKE}
      opacity={pill.isRemoteOnly ? 0.67 : 1}
      style={pill.isNonHead && !pill.isRemoteOnly ? 'filter: brightness(0.75)' : ''}
    />

    <!-- Pill capsule (fully rounded rect) -->
    <rect
      x={pill.x}
      y={pill.y - PILL_HEIGHT / 2}
      width={pill.width}
      height={PILL_HEIGHT}
      rx={PILL_HEIGHT / 2}
      ry={PILL_HEIGHT / 2}
      fill={laneColor(pill.colorIndex)}
      opacity={pill.isRemoteOnly ? 0.67 : 1}
      style={pill.isNonHead && !pill.isRemoteOnly ? 'filter: brightness(0.75)' : ''}
    />

    <!-- Pill text -->
    <text
      x={pill.x + PILL_PADDING_X + ICON_WIDTH}
      y={pill.y}
      fill="white"
      font-size={PILL_FONT_SIZE}
      font-family="var(--font-sans)"
      font-weight={pill.isHead ? 700 : 500}
      dominant-baseline="central"
    >{pill.truncatedLabel}</text>

    <!-- Overflow +N badge -->
    {#if pill.overflowCount > 0}
      <rect
        x={pill.x + pill.width + PILL_GAP}
        y={pill.y - BADGE_HEIGHT / 2}
        width={badgeWidth}
        height={BADGE_HEIGHT}
        rx={BADGE_HEIGHT / 2}
        ry={BADGE_HEIGHT / 2}
        fill={laneColor(pill.colorIndex)}
        style="filter: brightness(0.75)"
      />
      <text
        x={pill.x + pill.width + PILL_GAP + badgeWidth / 2}
        y={pill.y}
        fill="white"
        font-size={BADGE_FONT_SIZE}
        font-family="var(--font-sans)"
        font-weight="500"
        text-anchor="middle"
        dominant-baseline="central"
      >+{pill.overflowCount}</text>
    {/if}
  {/each}
</g>
```

### Pattern 4: HTML Overlay for Hover Expansion (Recommended Discretion Choice)
**What:** HTML div positioned absolutely over the SVG for hover-expand interaction
**When to use:** When user hovers over pill or +N badge, show all refs expanded
**Why HTML over SVG:** SVG `<text>` has no native line wrapping or smooth height animation. HTML provides `overflow`, `transition`, and familiar CSS layout.
**Example:**
```svelte
<!-- Positioned absolutely within the scroll container, outside the SVG -->
{#if hoveredPill}
  <div
    class="absolute z-50 rounded-lg shadow-lg"
    style="
      left: {hoveredPill.x}px;
      top: {hoveredPill.y - PILL_HEIGHT / 2}px;
      background: var(--lane-{hoveredPill.colorIndex % 8});
      padding: 4px 8px;
      transition: clip-path 180ms ease, opacity 120ms ease;
      clip-path: inset(0 0 0 0 round 8px);
      pointer-events: auto;
    "
  >
    {#each hoveredPill.allRefs as ref}
      <div class="text-[11px] leading-5 font-medium text-white whitespace-nowrap">
        {ref.short_name}
      </div>
    {/each}
  </div>
{/if}
```

### Pattern 5: SVG Path Icons for Tags and Stashes
**What:** Small inline SVG `<path>` elements replacing unicode prefixes
**When to use:** Before pill text for Tag and Stash ref types
**Example:**
```svelte
<!-- Tag icon (diamond/tag shape, ~10x10) -->
{#if pill.refType === 'Tag'}
  <path
    d="M {pill.x + 4} {pill.y - 3} l 3 -3 l 3 3 l -3 3 z"
    fill="white"
    opacity="0.9"
  />
{:else if pill.refType === 'Stash'}
  <!-- Stash icon (flag shape, ~8x10) -->
  <path
    d="M {pill.x + 3} {pill.y - 4} v 8 M {pill.x + 3} {pill.y - 4} h 5 v 4 h -5"
    fill="none"
    stroke="white"
    stroke-width="1.2"
    opacity="0.9"
  />
{/if}
```

### Anti-Patterns to Avoid
- **Using SVG `<foreignObject>` for pills:** Breaks pointer-events model (Phase 20 decision: `pointer-events: none` on SVG root). foreignObject has inconsistent behavior across WebKit/Blink.
- **Measuring text in the DOM after render:** Creates layout thrashing. All text measurement must happen in the `$derived` computation, not after SVG mount.
- **Filtering at the GraphCommit level:** Don't filter commits before building pill data. Build all pill data in `$derived`, then filter by visible range in the snippet (matching existing overlay pattern).
- **Absolute pixel positioning instead of row-based:** All Y coordinates must use `cy(rowIndex)` for consistency with dots/connections. Never hardcode pixel Y values.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Text width measurement | Character-counting heuristic | Canvas `measureText()` | Variable-width fonts make char-counting inaccurate; Canvas is precise and synchronous |
| Text truncation with ellipsis | Manual pixel-by-pixel trim | Binary search on `measureText()` | Efficient O(log n) truncation; handles any font/size |
| Ref sorting priority | Ad-hoc sort in rendering | Dedicated `sortRefs()` utility | HEAD priority, type ordering, consistent everywhere |
| Pill hover interaction | Pure SVG expansion | HTML overlay with CSS transition | SVG has no native text wrapping or height animation |

**Key insight:** SVG excels at shapes and lines but is poor at text layout. Use Canvas API for measurement (synchronous, no DOM), and HTML overlay for complex text interactions (wrapping, transitions).

## Common Pitfalls

### Pitfall 1: SVG Text Vertical Alignment
**What goes wrong:** SVG `<text>` uses baseline alignment by default, causing text to appear above or below the pill rect.
**Why it happens:** SVG text `y` attribute positions the text baseline, not the visual center.
**How to avoid:** Use `dominant-baseline="central"` on all `<text>` elements to center text vertically at the `y` coordinate.
**Warning signs:** Text appears offset vertically from pill background rects.

### Pitfall 2: Pill Position Coordinate Space
**What goes wrong:** Pills render at wrong positions because the SVG viewport starts at the graph column, but pills need to appear in the ref column area.
**Why it happens:** The current overlay SVG has `style="left: {columnWidths.ref}px"` — it starts at the graph column, not at x=0 of the page.
**How to avoid:** Two options: (A) Create a separate SVG positioned at x=0 for ref pills, or (B) use negative x coordinates for pills (since the SVG left edge is at the ref/graph boundary). Option A (separate SVG) is cleaner. Alternatively, adjust the overlay SVG to start earlier and cover both ref and graph columns.
**Warning signs:** Pills overlapping with graph lanes or appearing in wrong column.

### Pitfall 3: Canvas Font Must Match SVG Font
**What goes wrong:** Text truncation is off — text overflows pill rect or is truncated too aggressively.
**Why it happens:** Canvas `measureText()` uses its own font setting. If it doesn't match the SVG `<text>` font exactly, widths differ.
**How to avoid:** Use the exact same font string for Canvas measurement and SVG rendering: `"500 11px Inter, system-ui, -apple-system, sans-serif"` (matching `--font-sans`).
**Warning signs:** Text slightly overflows capsule, or excessive truncation on certain branch names.

### Pitfall 4: Hover Expansion z-index with SVG
**What goes wrong:** The HTML hover overlay renders behind the SVG or behind commit rows.
**Why it happens:** SVG overlay has `z-index: 1`, commit rows have various z-indexes. The hover overlay must be above both.
**How to avoid:** Position the hover overlay as a sibling of the SVG (not inside it), with `z-index: 50`. Place it in the same scroll container (`.virtual-list-content`) so it scrolls with content.
**Warning signs:** Hover overlay hidden behind graph elements or other rows.

### Pitfall 5: Remote-Only Detection Logic
**What goes wrong:** Remote dimming applied incorrectly — local branches dimmed, or remote branches of tracked branches not dimmed.
**Why it happens:** Current `isRemoteOnly()` checks if the ref is a `RemoteBranch` AND no sibling ref is `LocalBranch` or `Tag`. This logic must be preserved exactly.
**How to avoid:** Copy the `isRemoteOnly()` logic from `RefPill.svelte` into the pill data builder. Test with: (1) local-only branch, (2) remote-only branch, (3) tracked branch (both local + remote refs on same commit).
**Warning signs:** `origin/main` pill bright when it should be dimmed, or `main` pill dimmed when it should be bright.

### Pitfall 6: Ref Column Width Reactivity
**What goes wrong:** Pill widths don't update when user resizes the ref column.
**Why it happens:** `refColumnWidth` is a reactive state (`columnWidths.ref`). If `buildRefPillData()` doesn't react to width changes, pills stay stale.
**How to avoid:** Pass `columnWidths.ref` as a parameter to the `$derived` computation for pill data, ensuring Svelte's reactivity system tracks it.
**Warning signs:** After resizing ref column, pills still truncated to old width or overflow the column.

## Code Examples

### New Constants for Ref Pills
```typescript
// Source: Matching existing RefPill.svelte styling (11px font, px-1.5, py-0, rounded-full)
export const PILL_HEIGHT = 20;       // ~leading-5 (20px line height)
export const PILL_PADDING_X = 6;     // px-1.5 = 6px
export const PILL_FONT_SIZE = 11;    // text-[11px]
export const PILL_FONT = '500 11px Inter, system-ui, -apple-system, sans-serif';
export const PILL_FONT_BOLD = '700 11px Inter, system-ui, -apple-system, sans-serif';
export const PILL_GAP = 4;           // gap between pill and +N badge
export const PILL_MARGIN_LEFT = 4;   // left margin within ref column
export const BADGE_HEIGHT = 16;      // slightly smaller than pill
export const BADGE_FONT_SIZE = 10;   // text-[10px] matching current +N badge
export const ICON_WIDTH = 10;        // space reserved for tag/stash icons (0 for branches)
```

### Ref Sorting Priority
```typescript
// Source: Current RefPill.svelte behavior — HEAD branch always first
function sortRefs(refs: RefLabel[]): RefLabel[] {
  return [...refs].sort((a, b) => {
    // HEAD always first
    if (a.is_head && !b.is_head) return -1;
    if (!a.is_head && b.is_head) return 1;
    // Local branches before remotes
    const typeOrder: Record<RefType, number> = {
      LocalBranch: 0, Tag: 1, Stash: 2, RemoteBranch: 3
    };
    return (typeOrder[a.ref_type] ?? 9) - (typeOrder[b.ref_type] ?? 9);
  });
}
```

### Extending Overlay Visible Filtering
```typescript
// Source: Existing overlay-visible.ts pattern
export interface VisibleOverlayElements {
  rails: OverlayPath[];
  connections: OverlayPath[];
  dots: OverlayNode[];
  pills: OverlayRefPill[];  // NEW
}

// In getVisibleOverlayElements():
const pills = allPills.filter(p => p.rowIndex >= startRow && p.rowIndex <= endRow);
```

### Removing HTML Ref Pills from CommitRow
```svelte
<!-- CommitRow.svelte: Remove the entire ref column block (lines 54-103) -->
<!-- The ref column width spacer stays for layout alignment: -->
{#if columnVisibility.ref}
  <div class="flex-shrink-0" style="width: {columnWidths.ref}px;"></div>
{/if}
```

### Overlay SVG Expansion to Cover Ref Column
```svelte
<!-- CommitGraph.svelte: Expand SVG to cover ref + graph columns -->
<svg
  class="absolute top-0"
  width={columnWidths.ref + Math.max(maxColumns, 1) * LANE_WIDTH}
  height={contentHeight}
  style="left: 0; pointer-events: none; z-index: 1;"
>
  <!-- Existing layers offset by ref column width -->
  <g class="overlay-rails" transform="translate({columnWidths.ref}, 0)">
    <!-- ... existing rail rendering ... -->
  </g>
  <g class="overlay-connections" transform="translate({columnWidths.ref}, 0)">
    <!-- ... existing connection rendering ... -->
  </g>
  <g class="overlay-dots" transform="translate({columnWidths.ref}, 0)">
    <!-- ... existing dot rendering ... -->
  </g>
  <!-- New pill layer at x=0 (ref column area, no translate) -->
  <g class="overlay-pills">
    {#each visible.pills as pill}
      <!-- pill rendering as shown in Pattern 3 -->
    {/each}
  </g>
</svg>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HTML ref pills in CommitRow | SVG ref pills in overlay | Phase 26 | Eliminates z-index issues, enables connector lines as SVG paths |
| Unicode prefixes (diamond, flag) | SVG path icons | Phase 26 | Crisp at all zoom levels, consistent sizing |
| CSS text-overflow: ellipsis | Canvas measureText() + manual truncation | Phase 26 | Works in SVG context where CSS ellipsis unavailable |
| Per-row connector div | SVG `<line>` element | Phase 26 | Pixel-perfect alignment with commit dots |
| opacity: 0.5 for remote dimming | opacity: 0.65-0.70 | Phase 26 | Softer dimming, better readability |

**Note on the SVG separate from graph approach:** An alternative is to keep the graph overlay SVG as-is (starting at graph column) and create a second SVG for ref pills. This avoids breaking existing rendering code but adds complexity. The recommended approach (expanding the single SVG) is simpler because all elements share one coordinate space, and the `transform="translate()"` on existing groups is a clean separation.

## Open Questions

1. **Pill SVG coordinate space strategy**
   - What we know: Current SVG starts at `left: {columnWidths.ref}px`. Pills need to render in the ref column area (x < 0 in current space, or x=0 to refWidth in expanded space).
   - What's unclear: Whether expanding the SVG leftward introduces any issues with existing rail/connection/dot rendering.
   - Recommendation: Expand SVG to start at x=0 and add `transform="translate(refWidth, 0)"` to existing `<g>` groups. Test that existing rendering is pixel-identical.

2. **Canvas font loading timing**
   - What we know: `measureText()` needs the font to be loaded. On first render, Inter may not be loaded yet.
   - What's unclear: Whether Tauri bundles the font (making it instant) or loads it async.
   - Recommendation: Use a fallback measurement width if font isn't loaded. In practice, the `$derived` recomputes when fonts load due to layout shifts, so this is likely a non-issue.

3. **Hover overlay scroll synchronization**
   - What we know: The HTML hover overlay for expanding pills must scroll with the content.
   - What's unclear: Whether placing it in `.virtual-list-content` is sufficient or if it needs explicit scroll tracking.
   - Recommendation: Place inside `.virtual-list-content` (same as the SVG overlay). Position with `top` computed from `cy(rowIndex)`. This scrolls natively.

4. **Pointer events on pill area**
   - What we know: SVG root has `pointer-events: none` (Phase 20 decision). Pill hover needs `pointer-events: auto` on individual pills.
   - What's unclear: Whether adding `pointer-events: auto` to pill rects interferes with click-through to commit rows.
   - Recommendation: Add `pointer-events: auto` only to pill group elements. Use `onmouseenter`/`onmouseleave` on the pill `<rect>` and badge `<rect>`. Click events should still propagate to the underlying commit row div.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.0 |
| Config file | Inline in package.json (`"test": "vitest run"`) |
| Quick run command | `npx vitest run src/lib/ref-pill-data.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PILL-01 | Pill data computed from refs with correct position, size, color | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | :x: Wave 0 |
| PILL-01 | Text truncation with ellipsis respects max width | unit | `npx vitest run src/lib/text-measure.test.ts -x` | :x: Wave 0 |
| PILL-02 | Connector line coordinates from pill right edge to dot center | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | :x: Wave 0 |
| PILL-03 | Remote-only detection, dimming flags on pill data | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | :x: Wave 0 |
| PILL-04 | Overflow count computed correctly (refs.length - 1) | unit | `npx vitest run src/lib/ref-pill-data.test.ts -x` | :x: Wave 0 |
| PILL-04 | Hover expansion behavior | manual-only | Visual verification of hover interaction | N/A |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/ref-pill-data.test.ts src/lib/text-measure.test.ts -x`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/ref-pill-data.test.ts` — covers PILL-01, PILL-02, PILL-03, PILL-04 (data computation)
- [ ] `src/lib/text-measure.test.ts` — covers text measurement and truncation logic
- [ ] Constants in `graph-constants.ts` — pill-specific constants (PILL_HEIGHT, etc.)

Note: Text measurement tests can mock `measureText()` with a simple character-width function for deterministic testing without a real Canvas context. `buildRefPillData()` accepts `measureText` as a parameter for testability.

## Sources

### Primary (HIGH confidence)
- `src/components/RefPill.svelte` — Current HTML pill implementation, styling reference
- `src/components/CommitRow.svelte` lines 54-103 — Current connector + overflow badge implementation
- `src/components/CommitGraph.svelte` lines 498-551 — Three-layer overlay SVG rendering pattern
- `src/lib/overlay-visible.ts` — Visibility filtering pattern for virtualization
- `src/lib/overlay-paths.ts` — Path builder pipeline pattern
- `src/lib/types.ts` — OverlayNode, OverlayPath, RefLabel, RefType interfaces
- `src/lib/graph-constants.ts` — LANE_WIDTH=16, ROW_HEIGHT=36, EDGE_STROKE=1.5
- `src/app.css` — 8 lane color CSS custom properties, font-sans definition
- MDN Canvas `measureText()` docs — TextMetrics API for synchronous text measurement

### Secondary (MEDIUM confidence)
- Phase 23 RESEARCH.md — Three-layer `<g>` z-ordering pattern, virtualization strategy
- SVG `dominant-baseline="central"` — Standard SVG text vertical centering attribute

### Tertiary (LOW confidence)
- HTML overlay vs foreignObject tradeoff — Based on general web development knowledge, not project-specific testing. foreignObject may work fine in WebKit (Tauri's renderer), but the pointer-events interaction is untested.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Zero new dependencies, all browser primitives + existing patterns
- Architecture: HIGH — Direct extension of proven overlay pipeline (Phases 20-24)
- Pitfalls: HIGH — Based on direct code analysis of existing implementations
- Text measurement: MEDIUM — Canvas `measureText()` is standard API, but font loading timing in Tauri is untested
- Hover expansion: MEDIUM — HTML overlay approach is recommended but implementation details need validation

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable — no external dependency changes expected)
