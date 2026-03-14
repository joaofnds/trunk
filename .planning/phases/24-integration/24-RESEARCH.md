# Phase 24: Integration - Research

**Researched:** 2026-03-14
**Domain:** Svelte component integration, SVG pipeline unification, constant refactoring, dead code removal
**Confidence:** HIGH

## Summary

Phase 24 replaces the old per-row SVG rendering pipeline with the overlay pipeline as the sole rendering path. The work is primarily a wiring/cleanup phase — all overlay infrastructure (buildGraphData, buildOverlayPaths, getVisibleOverlayElements, graphOverlay snippet) is already fully functional in CommitGraph.svelte. The old pipeline (computeGraphSvgData → setContext → GraphCell) runs in parallel and must be removed, along with the dead component files (GraphCell.svelte, LaneSvg.svelte, graph-svg-data.ts and its test).

The constant unification is straightforward: the OVERLAY_ prefix constants become the primary constants with new values (ROW_HEIGHT=36, LANE_WIDTH=16, DOT_RADIUS=6, EDGE_STROKE=1.5). All consumers (overlay-paths.ts, CommitGraph.svelte, CommitRow.svelte) update their imports to the unified names. The stash dot changes from filled square to hollow dashed square. CommitRow's connector line and graph column use unified LANE_WIDTH/EDGE_STROKE.

**Primary recommendation:** Unify constants first, update all consumers, then remove old pipeline code, then delete dead files — this ordering prevents any intermediate broken state.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- ROW_HEIGHT: 36px (confirmed, no flexibility needed)
- LANE_WIDTH: 16px (confirmed, wider lanes accepted)
- DOT_RADIUS: 6px (bumped from overlay's 4px — same absolute size as old pipeline, proportionally smaller in wider lanes)
- EDGE_STROKE: 1.5px (unified from overlay value)
- MERGE_STROKE: 2px (unchanged)
- Drop the OVERLAY_ prefix entirely — OVERLAY_LANE_WIDTH becomes LANE_WIDTH, etc.
- Remove the old constant values (LANE_WIDTH=12, ROW_HEIGHT=26, DOT_RADIUS=6, EDGE_STROKE=1)
- Single set of constants in graph-constants.ts — no more dual naming
- Update all imports across the codebase to use the unified names
- graph-constants.test.ts updated to test new values
- Update CommitRow's HTML connector line to use the unified LANE_WIDTH (16px)
- Match connector line thickness to unified EDGE_STROKE (1.5px)
- Let graph column width flow naturally with wider lanes — no cap or special handling
- Minimal polish — Phase 26 replaces ref connectors with SVG entirely
- Stash dot: hollow dashed square (rect with fill="none", stroke with dasharray)
- Same stroke width and dash pattern as WIP circle (EDGE_STROKE, dasharray="3 3")

### Claude's Discretion
- Exact order of file deletions and import cleanup
- Whether to delete graph-svg-data.test.ts alongside graph-svg-data.ts (likely yes — tests for deleted code)
- Skeleton loading row height adjustment (currently uses ROW_HEIGHT)
- Any intermediate refactoring steps needed for clean integration

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TUNE-01 | Updated graph dimensions: ROW_HEIGHT increased from 26px to ~36px, LANE_WIDTH from 12px to ~16px | Constant unification in graph-constants.ts; all consumers identified (overlay-paths.ts, CommitGraph.svelte, CommitRow.svelte); test file update path mapped |
| TUNE-02 | 8-color lane palette applied via CSS custom properties on SVG elements | Already implemented — `--lane-0` through `--lane-7` defined in app.css, `laneColor()` helper uses `var(--lane-${idx % 8})` throughout overlay SVG rendering |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Svelte | 5.x | Component framework | Project's existing framework, $derived reactivity for graph data |
| Vitest | latest | Test runner | Already configured, 5 test files / 121 tests passing |
| TypeScript | 5.x | Type safety | Project's existing language |

### Supporting
No new libraries needed. This phase is purely integration and cleanup of existing code.

## Architecture Patterns

### Current Dual Pipeline (Being Unified)

```
CommitGraph.svelte currently runs TWO parallel pipelines:

OLD PIPELINE (to be removed):
  displayItems → computeGraphSvgData() → graphSvgData $derived
  → setContext('graphSvgData', ...) → GraphCell.svelte (getContext)
  → Per-row SVG with viewBox clipping

NEW PIPELINE (to become sole):
  displayItems → buildGraphData() → overlayGraphData $derived
  → buildOverlayPaths() → overlayPaths $derived
  → graphOverlay snippet → single SVG overlay with virtualized rendering
```

### Target Architecture (After Phase 24)

```
CommitGraph.svelte (sole pipeline):
  displayItems → buildGraphData() → graphData $derived
  → buildOverlayPaths() → paths $derived
  → graphOverlay snippet → getVisibleOverlayElements() → SVG overlay

CommitRow.svelte (simplified):
  - No GraphCell import
  - Graph column div remains for width/layout but renders no SVG
  - HTML connector line uses unified LANE_WIDTH/EDGE_STROKE
```

### Recommended File Structure After Phase 24
```
src/
├── lib/
│   ├── graph-constants.ts      # Unified constants (ROW_HEIGHT=36, LANE_WIDTH=16, etc.)
│   ├── graph-constants.test.ts # Updated tests for unified values
│   ├── active-lanes.ts         # buildGraphData() — unchanged logic, updated imports
│   ├── active-lanes.test.ts    # Unchanged
│   ├── overlay-paths.ts        # buildOverlayPaths() — updated imports (LANE_WIDTH, ROW_HEIGHT)
│   ├── overlay-paths.test.ts   # Updated hardcoded constants (LANE=16→16, ROW=26→36)
│   ├── overlay-visible.ts      # getVisibleOverlayElements() — unchanged
│   ├── overlay-visible.test.ts # Unchanged
│   └── types.ts                # SvgPathData type can be removed; Overlay* types stay
│ 
├── components/
│   ├── CommitGraph.svelte       # Sole overlay pipeline, no old imports
│   ├── CommitRow.svelte         # No GraphCell, unified constants
│   └── VirtualList.svelte       # Unchanged
│
│   # DELETED:
│   ├── GraphCell.svelte         # ❌ Removed
│   ├── LaneSvg.svelte           # ❌ Removed (already unused since Phase 17)
│   └── (graph-svg-data.ts)      # ❌ Removed from lib/
│   └── (graph-svg-data.test.ts) # ❌ Removed from lib/
```

### Pattern: Constant Unification

**What:** Replace dual constant sets (old + OVERLAY_) with single set at new values.

**Current state (graph-constants.ts):**
```typescript
// Old values (used by old pipeline)
export const LANE_WIDTH = 12;
export const ROW_HEIGHT = 26;
export const DOT_RADIUS = 6;
export const EDGE_STROKE = 1;
export const WIP_STROKE = 1.5;
export const MERGE_STROKE = 2;

// Overlay values (used by new pipeline)
export const OVERLAY_LANE_WIDTH = 16;
export const OVERLAY_ROW_HEIGHT = 26;
export const OVERLAY_DOT_RADIUS = 4;
export const OVERLAY_EDGE_STROKE = 1.5;
export const OVERLAY_MERGE_STROKE = 2;
```

**Target state:**
```typescript
export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 36;
export const DOT_RADIUS = 6;
export const EDGE_STROKE = 1.5;
export const MERGE_STROKE = 2;
```

**Key observations:**
- WIP_STROKE (1.5) is removed — unified EDGE_STROKE (1.5) replaces it
- OVERLAY_DOT_RADIUS was 4, but user decided DOT_RADIUS = 6 for this phase
- OVERLAY_ROW_HEIGHT was 26, user decided ROW_HEIGHT = 36 for this phase

### Pattern: Stash Dot Rendering Change

**Current stash rendering in overlay snippet (CommitGraph.svelte line 463-468):**
```svelte
{:else if node.isStash}
  <rect
    x={overlayCx(node.x) - OVERLAY_DOT_RADIUS}
    y={overlayCy(node.y) - OVERLAY_DOT_RADIUS}
    width={OVERLAY_DOT_RADIUS * 2}
    height={OVERLAY_DOT_RADIUS * 2}
    fill={laneColor(node.colorIndex)} />
```

**Target stash rendering (hollow dashed square):**
```svelte
{:else if node.isStash}
  <rect
    x={cx(node.x) - DOT_RADIUS}
    y={cy(node.y) - DOT_RADIUS}
    width={DOT_RADIUS * 2}
    height={DOT_RADIUS * 2}
    fill="none"
    stroke={laneColor(node.colorIndex)}
    stroke-width={EDGE_STROKE}
    stroke-dasharray="3 3" />
```

### Anti-Patterns to Avoid
- **Updating constants before removing old pipeline imports:** The old pipeline files (graph-svg-data.ts, GraphCell.svelte) import the old LANE_WIDTH/ROW_HEIGHT values. If you update constants first without removing these imports, tests for graph-svg-data.ts will fail because expected values change. Solution: delete old pipeline files and their tests first, OR update constants and delete simultaneously.
- **Leaving the setContext/getContext bridge:** The `setContext('graphSvgData', ...)` call in CommitGraph.svelte and `getContext('graphSvgData')` in GraphCell.svelte form a reactive context bridge. Both must be removed together.
- **Forgetting skeleton loading height:** CommitGraph.svelte lines 408 and 499 use `{ROW_HEIGHT}px` for skeleton loading rows. These automatically pick up the new value, but should be verified visually.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SVG rendering pipeline | New custom per-row SVG | Existing overlay pipeline | Already built, tested, and working in Phases 20-23 |
| Visibility filtering | Custom scroll-based filtering | getVisibleOverlayElements() | Already handles range intersection for rails and point containment for dots |
| Edge coalescing | Custom edge merging | buildGraphData() from active-lanes.ts | Already coalesces consecutive same-lane edges |

## Common Pitfalls

### Pitfall 1: Import Cascade on Constant Rename
**What goes wrong:** Renaming OVERLAY_LANE_WIDTH to LANE_WIDTH breaks overlay-paths.ts imports if done before updating that file's import statement.
**Why it happens:** overlay-paths.ts imports `OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT` directly.
**How to avoid:** Update graph-constants.ts AND all its consumers in the same step.
**Files importing OVERLAY_ constants:**
- `overlay-paths.ts` — imports OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT
- `CommitGraph.svelte` — imports OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT, OVERLAY_DOT_RADIUS, OVERLAY_EDGE_STROKE, OVERLAY_MERGE_STROKE
- `graph-constants.test.ts` — imports all OVERLAY_ constants

### Pitfall 2: Test Assertions Using Hardcoded Pixel Values
**What goes wrong:** overlay-paths.test.ts hardcodes `const LANE = 16; const ROW = 26;` for assertions. Changing ROW_HEIGHT to 36 means all ROW-dependent assertions use stale values.
**Why it happens:** Tests mirror constants locally for assertion calculations rather than importing them.
**How to avoid:** Update the local constants in overlay-paths.test.ts from `ROW = 26` to `ROW = 36`. Consider importing from graph-constants.ts directly, but the test pattern of local mirroring is intentional (tests verify the module's contract, not its internal constant usage).
**Warning signs:** Tests pass but produce different pixel values than the running application.

### Pitfall 3: CommitRow Connector Line Hardcoded Pixel Value
**What goes wrong:** CommitRow.svelte line 56 has a hardcoded `left: {12 + refContainerWidth}px` — the `12` is the old LANE_WIDTH padding. After LANE_WIDTH changes to 16, this should be updated.
**Why it happens:** The `12` was hardcoded rather than using the LANE_WIDTH constant.
**How to avoid:** This needs to be identified and updated. However, note this is intentional padding, not necessarily LANE_WIDTH. Investigate if it should be `LANE_WIDTH` or remains a fixed padding.

### Pitfall 4: Graph Column Min-Width Calculation
**What goes wrong:** CommitGraph.svelte line 59 uses `Math.max(maxColumns, 1) * LANE_WIDTH` for graph column minimum width. The old LANE_WIDTH (12) will automatically update to 16, making graph columns wider — this is correct behavior per the decision "let graph column width flow naturally with wider lanes."
**Why it happens:** The constant is already referenced; the width increase is intentional.
**How to avoid:** No action needed — this is expected. Just verify the column resize still works.

### Pitfall 5: CommitRow Graph Column Min-Width
**What goes wrong:** CommitRow.svelte line 106 uses `min-width: {Math.max(maxColumns, commit.column + 1) * LANE_WIDTH}px`. This ensures the graph column can hold all lanes. With LANE_WIDTH increasing from 12 to 16, this automatically grows — correct.
**How to avoid:** Verify the old `GraphCell` usage in this div is removed (the `<GraphCell>` component renders its own SVG inside this div).

## Code Examples

### Exact Changes Required

#### 1. graph-constants.ts — Unified Constants
```typescript
// Source: CONTEXT.md locked decisions
export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 36;
export const DOT_RADIUS = 6;
export const EDGE_STROKE = 1.5;
export const MERGE_STROKE = 2;
// WIP_STROKE removed — EDGE_STROKE (1.5) replaces it
// All OVERLAY_ constants removed — unified into above
```

#### 2. overlay-paths.ts — Import Update
```typescript
// Before:
import { OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT } from './graph-constants.js';
// ...
function cx(col: number): number { return col * OVERLAY_LANE_WIDTH + OVERLAY_LANE_WIDTH / 2; }
const R = OVERLAY_LANE_WIDTH / 2;

// After:
import { LANE_WIDTH, ROW_HEIGHT } from './graph-constants.js';
// ...
function cx(col: number): number { return col * LANE_WIDTH + LANE_WIDTH / 2; }
const R = LANE_WIDTH / 2;
```

#### 3. CommitGraph.svelte — Old Pipeline Removal
```typescript
// REMOVE these lines:
import { computeGraphSvgData } from '../lib/graph-svg-data.js';
const graphSvgData = $derived.by(() => { return computeGraphSvgData(displayItems, maxColumns); });
setContext('graphSvgData', { get data() { return graphSvgData; } });

// UPDATE import to unified names:
import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, MERGE_STROKE } from '../lib/graph-constants.js';

// UPDATE overlayCx/overlayCy to use unified names:
const cx = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
const cy = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

// UPDATE defaultEstimatedItemHeight:
defaultEstimatedItemHeight={ROW_HEIGHT}  // now 36, was 26

// UPDATE SVG overlay to use unified constant names throughout
```

#### 4. CommitRow.svelte — GraphCell Removal
```svelte
<!-- REMOVE: -->
import GraphCell from './GraphCell.svelte';

<!-- In graph column, REMOVE GraphCell usage: -->
<!-- Before: -->
<div class="relative z-[1] flex items-center flex-shrink-0" style="width: {columnWidths.graph}px; min-width: {Math.max(maxColumns, commit.column + 1) * LANE_WIDTH}px;">
  <GraphCell {commit} {rowIndex} {maxColumns} />
</div>

<!-- After: graph column div remains for layout but is empty (overlay handles rendering): -->
<div class="relative z-[1] flex items-center flex-shrink-0" style="width: {columnWidths.graph}px; min-width: {Math.max(maxColumns, commit.column + 1) * LANE_WIDTH}px;">
</div>
```

## Complete Consumer Map

### Files Importing from graph-constants.ts (ALL must be updated)

| File | Current Imports | Action |
|------|----------------|--------|
| `CommitGraph.svelte` | LANE_WIDTH, ROW_HEIGHT, OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT, OVERLAY_DOT_RADIUS, OVERLAY_EDGE_STROKE, OVERLAY_MERGE_STROKE | Remove OVERLAY_ imports, use unified names |
| `CommitRow.svelte` | LANE_WIDTH, ROW_HEIGHT, EDGE_STROKE | Names stay, values change automatically |
| `overlay-paths.ts` | OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT | Change to LANE_WIDTH, ROW_HEIGHT |
| `GraphCell.svelte` | LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, WIP_STROKE, MERGE_STROKE | **DELETE FILE** |
| `LaneSvg.svelte` | LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, WIP_STROKE, MERGE_STROKE | **DELETE FILE** |
| `graph-svg-data.ts` | LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS | **DELETE FILE** |
| `graph-svg-data.test.ts` | LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS | **DELETE FILE** |
| `graph-constants.test.ts` | All old + all OVERLAY_ | Rewrite for unified constants |
| `overlay-paths.test.ts` | None (hardcoded LANE=16, ROW=26) | Update ROW=26 to ROW=36 |

### Files to Delete
| File | Reason | Last Import/Consumer |
|------|--------|---------------------|
| `src/components/GraphCell.svelte` | Old per-row SVG renderer | CommitRow.svelte (to be cleaned) |
| `src/components/LaneSvg.svelte` | Old per-row SVG renderer (already unused since Phase 17) | None |
| `src/lib/graph-svg-data.ts` | Old pipeline data computation | CommitGraph.svelte (to be cleaned) |
| `src/lib/graph-svg-data.test.ts` | Tests for deleted code | Self-contained |

### Types Potentially Affected
| Type | Location | Action |
|------|----------|--------|
| `SvgPathData` | types.ts line 110-114 | Can be removed — only used by graph-svg-data.ts and GraphCell.svelte |
| `OverlayNode` | types.ts line 136-145 | Keep — used by active-lanes.ts, overlay-visible.ts |
| `OverlayEdge` | types.ts line 147-154 | Keep |
| `OverlayGraphData` | types.ts line 156-160 | Keep |
| `OverlayPath` | types.ts line 162-169 | Keep |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-row viewBox-clipped SVGs (GraphCell) | Single overlay SVG with virtualized rendering | Phase 20-23 (v0.5) | Continuous bezier paths, no per-row seams |
| Manhattan routing (arc corners) | Cubic bezier corners (kappa approximation) | Phase 22 | Smoother visual curves |
| Dual constants (old + OVERLAY_) | Single unified set | Phase 24 (this phase) | Clean codebase, single source of truth |
| LANE_WIDTH=12, ROW_HEIGHT=26 | LANE_WIDTH=16, ROW_HEIGHT=36 | Phase 24 (this phase) | Wider, taller graph rows for readability |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (latest, configured via vite) |
| Config file | vite.config.ts (test section) |
| Quick run command | `npx vitest run` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TUNE-01 | ROW_HEIGHT=36, LANE_WIDTH=16 | unit | `npx vitest run src/lib/graph-constants.test.ts -x` | ✅ (needs update) |
| TUNE-01 | overlay-paths uses new ROW_HEIGHT=36 | unit | `npx vitest run src/lib/overlay-paths.test.ts -x` | ✅ (needs update) |
| TUNE-01 | active-lanes unchanged behavior | unit | `npx vitest run src/lib/active-lanes.test.ts -x` | ✅ |
| TUNE-01 | overlay-visible unchanged behavior | unit | `npx vitest run src/lib/overlay-visible.test.ts -x` | ✅ |
| TUNE-02 | Lane colors via CSS custom properties | manual-only | Visual verification | N/A — CSS custom properties in app.css, laneColor() helper tested implicitly |

### Sampling Rate
- **Per task commit:** `npx vitest run`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. Tests need value updates, not new test files.

## Open Questions

1. **CommitRow hardcoded `12` in connector line `left` style**
   - What we know: Line 56 has `left: {12 + refContainerWidth}px`. The `12` appears to be the old LANE_WIDTH as a left padding offset.
   - What's unclear: Whether this is intentional padding or should track LANE_WIDTH.
   - Recommendation: Replace with `LANE_WIDTH` or a derived constant since it's clearly related to the lane width (connector line starts at the left edge of the graph column, offset by one lane width for the ref pill padding). Currently the ref container already handles its own width measurement, so the `12` likely was `LANE_WIDTH`. Update to use the constant.

2. **Skeleton row height granularity**
   - What we know: Skeleton rows use `{ROW_HEIGHT}px` which will automatically become 36px.
   - What's unclear: Whether 36px skeleton rows look correct visually.
   - Recommendation: Accept the automatic change — skeleton height should match actual row height. Verify visually.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection: All source files read and analyzed
- `graph-constants.ts` — current dual constant definitions
- `CommitGraph.svelte` — both pipelines visible, all integration points identified
- `CommitRow.svelte` — GraphCell usage and connector line identified
- `overlay-paths.ts`, `overlay-paths.test.ts` — OVERLAY_ import locations confirmed
- `graph-svg-data.ts`, `graph-svg-data.test.ts` — deletion candidates confirmed
- `GraphCell.svelte`, `LaneSvg.svelte` — deletion candidates confirmed
- `app.css` — 8 lane colors confirmed at lines 13-20
- `types.ts` — SvgPathData type identified for potential removal

### Secondary (MEDIUM confidence)
- CONTEXT.md locked decisions — user-confirmed dimension values

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, purely existing code refactoring
- Architecture: HIGH — both pipelines fully read and understood, all integration points mapped
- Pitfalls: HIGH — all consumer files identified via grep, import chains traced
- Constant values: HIGH — user locked all dimension values in CONTEXT.md

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable — internal refactoring, no external dependencies)
