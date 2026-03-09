# Phase 8: Straight Rail Rendering - Research

**Researched:** 2026-03-09
**Domain:** SVG rendering of git commit graph lanes (vertical rails, merge/fork edges, commit dots) in per-row inline SVGs within a Svelte 5 / Tauri app
**Confidence:** HIGH

## Summary

Phase 8 transforms the current dot-only graph into a full GitKraken-style lane rendering with continuous vertical colored lines, Manhattan-routed merge/fork edges with rounded corners, and commit dots rendered on top. All the data needed for rendering is already available from the Rust backend -- `GraphCommit.edges` contains pass-through, merge, and fork edges with column positions and color indices. The work is entirely frontend SVG rendering within `LaneSvg.svelte`.

The key challenge is the per-row SVG architecture: each commit row renders its own inline SVG, so vertical continuity must be achieved by drawing rail segments that extend from top to bottom of each row (full `rowHeight`), with overlap to prevent sub-pixel gaps between adjacent rows. The backend already emits `Straight` edges for pass-through lanes, so the frontend simply needs to render vertical lines for each `Straight` edge and the commit's own lane.

**Primary recommendation:** Modify `LaneSvg.svelte` to render three SVG layers in order: (1) vertical rail lines for all `Straight` edges, (2) Manhattan-routed paths for merge/fork edges, (3) commit dot circle on top. Use `overflow: visible` (already set) with 0.5px vertical overlap to eliminate sub-pixel seams.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Medium weight lines (2.5-3px stroke width), round line caps (stroke-linecap: round), full opacity (1.0)
- Manhattan routing with rounded corners for merge/fork edges -- NOT straight diagonals
- Edge path: horizontal out from commit dot, rounded 90-degree turn at target column, vertical to target commit
- Corner radius: ~6px (half of 12px laneWidth)
- Horizontal edges draw ON TOP of vertical rails they cross
- Edge uses source branch color (color_index from GraphEdge)
- Horizontal + vertical segments stay within the row where the connection originates
- Dot renders on top of rail lines, no gap/ring -- rail is continuous behind, dot covers the junction
- Always matches lane color (color_index) -- no special HEAD/selected styling
- Uniform size: r=4 for all commits (merge distinction deferred to Phase 10)
- Custom dark-theme palette, 8 colors cycling (--lane-0 through --lane-7), vivid & saturated
- HEAD (color_index 0) is just the first color in rotation, no special treatment
- GitKraken is the definitive visual reference

### Claude's Discretion
- Sub-pixel gap fix technique (overflow:visible + 0.5px overlap or alternative)
- Exact color hex values for the 8-color vivid palette
- SVG element ordering for correct layering (rails, merge edges, dots)
- Edge path construction details (SVG path d-string with arc commands for rounded corners)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| LANE-01 | User sees continuous vertical colored lines connecting commits in the same branch | Render vertical `<line>` for each `Straight` edge (pass-through and own-lane) spanning full rowHeight with 0.5px overlap; use `color_index` to select lane color |
| LANE-03 | User sees all active branch lanes drawn through every commit row, not just that branch's own commits | Backend already emits `Straight` pass-through edges for all active lanes at each commit row; frontend renders them all |
| LANE-04 | User sees consistent lane colors per branch from tip to base | Backend assigns `color_index` per lane via `lane_colors` HashMap; frontend maps `color_index % 8` to CSS variable `--lane-N` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5.x | Component framework | Already in use; `$props()`, `$derived()` runes pattern |
| Inline SVG | N/A (browser native) | Per-row graph rendering | Already established; works with virtual scrolling |
| CSS Custom Properties | N/A | Lane color theming | Already in use (`--lane-0` through `--lane-7` in `app.css`) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| TailwindCSS | 4.x | Utility classes | Already used in CommitRow layout |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Per-row inline SVG | Single SVG column | Defeats virtual scrolling; memory grows with commit count (OUT OF SCOPE per REQUIREMENTS.md) |
| SVG `<line>` elements | Canvas 2D | Would require rewriting entire graph column; SVG integrates with DOM events and accessibility |

**Installation:** No new packages required. All rendering uses browser-native SVG within existing Svelte components.

## Architecture Patterns

### Recommended SVG Layer Order in LaneSvg.svelte

```
<svg>
  <!-- Layer 1: Vertical rail lines (bottom) -->
  {#each straightEdges as edge}
    <line ... />
  {/each}

  <!-- Layer 2: The commit's own rail line -->
  <line ... />

  <!-- Layer 3: Merge/Fork edge paths (middle) -->
  {#each connectionEdges as edge}
    <path ... />
  {/each}

  <!-- Layer 4: Commit dot (top) -->
  <circle ... />
</svg>
```

SVG elements render in document order (later = on top), so this layering naturally produces: rails behind everything, merge edges on top of rails, dot on top of everything.

### Pattern 1: Vertical Rail Rendering

**What:** Each `Straight` edge (where `from_column === to_column`) renders as a vertical line spanning the full row height, plus 0.5px overlap top and bottom to prevent sub-pixel gaps.

**When to use:** Every row, for every `Straight` edge in `commit.edges`, plus the commit's own lane if it has a first-parent continuation.

**Example:**
```svelte
<!-- Vertical rail line for a pass-through lane -->
<line
  x1={cx(edge.from_column)}
  y1={-0.5}
  x2={cx(edge.to_column)}
  y2={rowHeight + 0.5}
  stroke={laneColor(edge.color_index)}
  stroke-width={2.5}
  stroke-linecap="round"
/>
```

Key details:
- `y1 = -0.5` and `y2 = rowHeight + 0.5` extends the line 0.5px beyond row boundaries
- `overflow: visible` on the SVG (already set) allows these extensions to render
- Adjacent rows overlap by 1px total, eliminating sub-pixel seams at all zoom levels

### Pattern 2: Manhattan Edge Routing with Rounded Corners

**What:** Merge/fork edges use horizontal-then-vertical (or vertical-then-horizontal) paths with rounded 90-degree corners via SVG arc commands.

**When to use:** Any edge where `from_column !== to_column` (MergeLeft, MergeRight, ForkLeft, ForkRight).

**Example (MergeRight -- commit at from_column, target at to_column > from_column):**
```svelte
<!-- Manhattan-routed merge edge with rounded corner -->
<path
  d={`M ${cx(edge.from_column)} ${cy}
      H ${cx(edge.to_column) - cornerRadius}
      A ${cornerRadius} ${cornerRadius} 0 0 1 ${cx(edge.to_column)} ${cy + cornerRadius}
      V ${rowHeight + 0.5}`}
  fill="none"
  stroke={laneColor(edge.color_index)}
  stroke-width={2.5}
  stroke-linecap="round"
/>
```

The SVG `A` (arc) command draws a quarter-circle at the corner:
- `A rx ry rotation large-arc-flag sweep-flag x y`
- `rx = ry = cornerRadius` (6px, half of laneWidth)
- `large-arc-flag = 0` (short arc)
- `sweep-flag` = 0 or 1 depending on direction (0 = counter-clockwise, 1 = clockwise)

### Pattern 3: Edge Path Direction Logic

The routing direction depends on edge type and the relative positions of `from_column` and `to_column`:

| Edge Type | Path | Sweep |
|-----------|------|-------|
| MergeRight (to_column > from_column) | H right, arc turn down, V down | sweep=1 |
| MergeLeft (to_column < from_column) | H left, arc turn down, V down | sweep=0 |
| ForkRight (to_column > from_column) | V up, arc turn right, H right out (or start at dot, go H right, arc turn up, V up) | Depends on direction |
| ForkLeft (to_column < from_column) | Similar but leftward | Depends on direction |

For merge edges originating from the commit:
- Start at commit dot center `(cx(from_column), cy)`
- Go horizontally to `cx(to_column) +/- cornerRadius`
- Arc 90 degrees
- Go vertically to row edge (`rowHeight + 0.5` downward, or `-0.5` upward)

For fork edges (commit connecting to parent in a different column):
- Same pattern but the vertical segment goes upward (toward the parent row below in the list, which is chronologically before)

**Important:** In the data model, edges on a commit row describe connections FROM this row. `Straight` edges pass through. Merge/Fork edges start at `from_column` (this commit's position) and end at `to_column` (the target lane). The vertical segment continues in the next row as a `Straight` pass-through until reaching the target commit.

### Pattern 4: Commit's Own Rail Line

The commit itself needs a rail line drawn at its own column. This is NOT always included in the edges array -- it depends on whether the commit has a first-parent `Straight` edge. The commit's own rail should render:
- From top of row to bottom of row (through the dot) if the branch continues both above and below
- From top to dot center if this is the branch's first commit (tip)
- From dot center to bottom if this is the branch's last commit (base/root)

Determining this from the data:
- If `commit.edges` includes a `Straight` edge where `from_column === to_column === commit.column`, the lane continues downward
- If the commit is at the top of its branch (no incoming lane from above), draw from dot center down only
- The simplest approach: always draw the full rail line at the commit's column, and let the dot render on top. The rail appears continuous through the dot.

### Anti-Patterns to Avoid
- **Rendering rails with gaps at dots:** The rail line should be continuous behind the dot. The dot covers the rail, not the other way around.
- **Using `stroke-dasharray` for dashed connections in this phase:** Dashed WIP connections are Phase 10. All rails here are solid.
- **Filtering edges client-side:** The backend already provides exactly the right edges per row. Trust the data.
- **Using CSS transforms for positioning:** Use SVG coordinate math (`cx()` helper). CSS transforms can cause sub-pixel alignment issues.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Lane color mapping | Custom color lookup table | `laneColor(idx)` helper already exists, maps to CSS vars | Centralized, theme-able, already proven |
| Column-to-pixel conversion | Inline arithmetic | `cx(col)` helper already exists | Consistent positioning across all SVG elements |
| Edge data computation | Frontend lane algorithm | `commit.edges` from Rust backend | Backend already computes pass-through edges, merge/fork edges with correct color_index |
| Virtual scrolling | Custom scroll virtualization | `@humanspeak/svelte-virtual-list` already integrated | Already working with 26px row height |

**Key insight:** The Rust backend does all the heavy algorithmic work. The frontend's job is purely to render the pre-computed edge data as SVG elements. No graph algorithm logic should exist in the frontend.

## Common Pitfalls

### Pitfall 1: Sub-pixel Gaps Between Rows
**What goes wrong:** Visible hairline gaps between adjacent row SVGs at certain browser zoom levels (125%, 150%, etc.)
**Why it happens:** Browser rasterization rounds SVG coordinates to device pixels independently per element, creating 0.5-1px gaps
**How to avoid:** Extend rail lines 0.5px beyond row boundaries (`y1=-0.5`, `y2=rowHeight+0.5`) with `overflow: visible` on the SVG. This creates a 1px overlap between adjacent rows.
**Warning signs:** Faint horizontal lines visible when scrolling the graph, especially on non-integer zoom levels

### Pitfall 2: Wrong SVG Element Order (Z-index)
**What goes wrong:** Dots render behind rails, or merge edges render behind vertical rails they should cross over
**Why it happens:** SVG has no z-index -- elements render in document order (later = on top)
**How to avoid:** Strict element ordering: rail lines first, then merge/fork paths, then commit dot circle last
**Warning signs:** Dots invisible or partially occluded by colored lines

### Pitfall 3: Arc Sweep Direction Errors
**What goes wrong:** Rounded corners curve the wrong way, creating "S" shapes or inverted corners
**Why it happens:** The SVG arc `sweep-flag` parameter (0=counter-clockwise, 1=clockwise) is easy to get backwards
**How to avoid:** Build a lookup table mapping `(edge_type, direction)` to the correct sweep flag. Test each of the 4 edge types visually.
**Warning signs:** Merge lines that curve away from the target lane instead of toward it

### Pitfall 4: Missing Pass-through Rails
**What goes wrong:** Lanes appear to have gaps at rows where they don't own the commit
**Why it happens:** Only rendering edges for the commit's own column, forgetting pass-through `Straight` edges
**How to avoid:** Iterate ALL edges in `commit.edges`, not just the commit's own column. The backend already includes pass-through edges.
**Warning signs:** Lanes that appear only at commits, not between them

### Pitfall 5: Commit Dot Using Wrong Color
**What goes wrong:** Dot color doesn't match the lane it sits on
**Why it happens:** Using `commit.column % 8` instead of `commit.color_index` for the dot color
**How to avoid:** Always use `commit.color_index` for the dot, never compute color from column position
**Warning signs:** Dot color changes at certain commits within the same branch

### Pitfall 6: Edge Color Inconsistency
**What goes wrong:** Merge/fork edges use the wrong branch's color
**Why it happens:** Using the commit's color_index instead of the edge's color_index
**How to avoid:** Each `GraphEdge` has its own `color_index` -- always use `edge.color_index`, not `commit.color_index`
**Warning signs:** Merge lines that change color at the corner

## Code Examples

### Complete LaneSvg Rendering Structure (verified against existing codebase)

```svelte
<script lang="ts">
  import type { GraphCommit } from '../lib/types.js';

  interface Props {
    commit: GraphCommit;
    laneWidth?: number;
    rowHeight?: number;
    maxColumns?: number;
  }

  let { commit, laneWidth = 12, rowHeight = 26, maxColumns = 1 }: Props = $props();

  const cx = (col: number) => col * laneWidth + laneWidth / 2;
  const cy = rowHeight / 2;
  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
  const cornerRadius = laneWidth / 2; // 6px

  const svgWidth = $derived(Math.max(maxColumns, commit.column + 1) * laneWidth);

  // Separate edges by type for layered rendering
  const straightEdges = $derived(
    commit.edges.filter(e => e.from_column === e.to_column)
  );
  const connectionEdges = $derived(
    commit.edges.filter(e => e.from_column !== e.to_column)
  );
</script>

<svg width={svgWidth} height={rowHeight} style="overflow: visible; flex-shrink: 0;">
  <!-- Layer 1: Vertical rail lines (pass-through + own lane) -->
  {#each straightEdges as edge}
    <line
      x1={cx(edge.from_column)}
      y1={-0.5}
      x2={cx(edge.to_column)}
      y2={rowHeight + 0.5}
      stroke={laneColor(edge.color_index)}
      stroke-width={2.5}
      stroke-linecap="round"
    />
  {/each}

  <!-- Layer 2: Merge/Fork connection paths -->
  {#each connectionEdges as edge}
    <path
      d={buildEdgePath(edge)}
      fill="none"
      stroke={laneColor(edge.color_index)}
      stroke-width={2.5}
      stroke-linecap="round"
    />
  {/each}

  <!-- Layer 3: Commit dot (topmost) -->
  <circle
    cx={cx(commit.column)}
    {cy}
    r={4}
    fill={laneColor(commit.color_index)}
  />
</svg>
```

### Manhattan Edge Path Builder

```typescript
function buildEdgePath(edge: GraphEdge): string {
  const x1 = cx(edge.from_column);
  const x2 = cx(edge.to_column);
  const r = cornerRadius;
  const goingRight = x2 > x1;
  const sign = goingRight ? 1 : -1;

  // Determine if this is a "downward" connection (merge/fork going to row below)
  // or "upward" (going to row above)
  const isDownward = edge.edge_type === 'MergeLeft' || edge.edge_type === 'MergeRight'
    || edge.edge_type === 'ForkLeft' || edge.edge_type === 'ForkRight';

  // For all merge/fork edges in this model:
  // Start at commit dot center, go horizontal to target column, then vertical down
  // The sweep flag controls corner direction:
  //   Going right + down: sweep=1
  //   Going left + down:  sweep=0
  const sweepFlag = goingRight ? 1 : 0;

  return `M ${x1} ${cy} H ${x2 - sign * r} A ${r} ${r} 0 0 ${sweepFlag} ${x2} ${cy + r} V ${rowHeight + 0.5}`;
}
```

### Vivid Dark-Theme Color Palette

The existing palette in `app.css` needs evaluation. Current values:
```css
--lane-0: #4dc9f6;  /* cyan -- decent */
--lane-1: #f67019;  /* orange -- good */
--lane-2: #f53794;  /* pink -- good */
--lane-3: #537bc4;  /* blue -- slightly muted */
--lane-4: #acc236;  /* lime -- good */
--lane-5: #166a8f;  /* teal -- too dark, low contrast on dark bg */
--lane-6: #00a950;  /* green -- decent */
--lane-7: #58595b;  /* gray -- too dark, virtually invisible on dark bg */
```

Recommended vivid replacement (higher contrast against `#0d1117` background):
```css
--lane-0: #58a6ff;  /* bright blue (GitHub-style) */
--lane-1: #f78166;  /* warm orange */
--lane-2: #f778ba;  /* vivid pink */
--lane-3: #d2a8ff;  /* soft purple */
--lane-4: #7ee787;  /* bright green */
--lane-5: #ffa657;  /* amber */
--lane-6: #79c0ff;  /* sky blue */
--lane-7: #ff7b72;  /* coral red */
```

All 8 colors should have WCAG AA contrast ratio (4.5:1+) against the `#0d1117` background. The existing `--lane-5` (#166a8f) and `--lane-7` (#58595b) are particularly problematic -- they're nearly invisible on the dark background.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Dot-only rendering | Full lane rendering | Phase 8 (now) | Visual graph goes from minimal to full GitKraken-style |
| `commit.column % 8` for color | `commit.color_index` for color | Phase 7 | Colors are branch-specific, not column-position-based |
| No edge rendering | Backend provides all edge data | Phase 7 | Frontend receives pre-computed edges, no client-side graph algorithm needed |

**Current state:**
- `LaneSvg.svelte` renders only a `<circle>` for the commit dot (29 lines total)
- `commit.edges` array is populated but completely ignored by the frontend
- CSS variables `--lane-0` through `--lane-7` are defined but some values have poor contrast
- `overflow: visible` is already set on the SVG element

## Open Questions

1. **Edge path direction for fork edges going "upward"**
   - What we know: In the topological commit list, parent commits appear BELOW child commits. Fork edges connect a child to a parent in a different column. The vertical segment of the fork edge needs to go downward in screen space (toward higher row indices) to reach the parent.
   - What's unclear: Whether fork edges from the current row's `edges` array should render the vertical segment going down (toward the parent) or just render the horizontal departure + corner, with the vertical continuation handled by `Straight` pass-through edges in subsequent rows.
   - Recommendation: Analyze the actual edge data from the backend. Based on the backend code, the vertical continuation is handled by pass-through `Straight` edges in subsequent rows. The fork/merge edge on the originating row should only render the horizontal segment + corner + vertical segment to the row boundary (`rowHeight + 0.5` or `-0.5`). The pass-through `Straight` edges in subsequent rows handle the rest.

2. **Root commit rail rendering**
   - What we know: Root commits have no parents, so they have no first-parent `Straight` edge. But the rail should still show from the top of the row to the dot center.
   - What's unclear: Whether the backend emits any edge for the root commit's own column that would cause a rail to be drawn.
   - Recommendation: Check if root commits lack a self-straight edge (the test `root_has_self_straight` confirms root commits do NOT have a self-straight edge). May need special handling: if the commit is not a branch tip (has pass-through edges from above), draw a half-rail from top to dot center.

3. **Branch tip rail rendering**
   - What we know: Branch tips (first commits in topological order for their lane) have no pass-through edge from above.
   - What's unclear: Whether a half-rail (dot center to bottom) should render at branch tips, or if only the dot is sufficient.
   - Recommendation: Draw a half-rail from dot center down to row bottom for branch tips that have a first-parent continuation (Straight edge downward exists). For commits with no downward continuation, just the dot. This creates the visual effect of the branch "starting" at the tip commit.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust: `cargo test` (built-in), Frontend: none (no vitest/jest configured) |
| Config file | `src-tauri/Cargo.toml` for Rust tests |
| Quick run command | `cd src-tauri && cargo test git::graph` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LANE-01 | Continuous vertical lines connecting commits | manual | Visual inspection in running app | N/A (rendering) |
| LANE-03 | All active lanes drawn through every row | unit (Rust) | `cd src-tauri && cargo test git::graph::tests::branch_fork_topology -x` | Exists (verifies backend emits pass-through edges) |
| LANE-04 | Consistent lane colors per branch | unit (Rust) | `cd src-tauri && cargo test git::graph::tests::color_index_deterministic -x` | Exists |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test git::graph`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** Full suite green + visual inspection of graph rendering

### Wave 0 Gaps
- [ ] No frontend test framework configured (vitest/jest) -- acceptable for this phase since work is pure SVG rendering best validated visually
- [ ] No automated visual regression tests -- acceptable for MVP, could add Playwright screenshot tests later

*(Frontend rendering changes are best validated by visual inspection. The Rust backend tests already validate that correct edge data is emitted. The frontend's job is to faithfully render that data.)*

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/components/LaneSvg.svelte`, `src/lib/types.ts`, `src-tauri/src/git/graph.rs`, `src-tauri/src/git/types.rs` -- complete understanding of data structures and current rendering
- [MDN SVG Paths](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorials/SVG_from_scratch/Paths) -- SVG path arc command syntax
- [pvigier.github.io commit graph drawing algorithms](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html) -- GitKraken's "straight branches" approach confirmed

### Secondary (MEDIUM confidence)
- [Fix SVG Line Between Shapes (JunKangWorld)](https://junkangworld.com/blog/fix-svg-line-between-shapes-3-ultimate-methods-for-2025) -- sub-pixel gap fix techniques
- Existing project decisions in STATE.md -- sub-pixel gaps documented as likely v0.1 failure cause, overflow:visible with 0.5px overlap recommended

### Tertiary (LOW confidence)
- Color palette recommendations -- derived from analysis of contrast ratios against `#0d1117` background; specific hex values should be validated visually

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries needed, all existing infrastructure
- Architecture: HIGH -- data model fully understood, rendering is straightforward SVG
- Pitfalls: HIGH -- sub-pixel gaps documented from v0.1 failure, SVG layering well-understood
- Edge path routing: MEDIUM -- arc sweep direction logic needs careful testing for all 4 edge types
- Color palette: LOW -- hex values are recommendations, need visual validation

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable domain -- SVG rendering, no fast-moving dependencies)
