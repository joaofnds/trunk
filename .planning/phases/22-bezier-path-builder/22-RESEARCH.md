# Phase 22: Bezier Path Builder - Research

**Researched:** 2026-03-14
**Domain:** SVG path generation — Manhattan routing with cubic bezier rounded corners
**Confidence:** HIGH

## Summary

Phase 22 transforms `OverlayEdge[]` (from Phase 21's `buildGraphData()`) into SVG path `d` strings. The phase is a pure geometry/math module with no DOM interaction. There are two kinds of output paths: **rails** (continuous vertical lines for same-lane edges) and **connections** (Manhattan-routed edges with 90° rounded corners for cross-lane edges).

The core challenge is replacing the legacy SVG arc (`A` command) rounded corners with cubic bezier (`C` command) rounded corners while maintaining the Manhattan routing style (vertical → horizontal → turn or vice versa). The math for approximating a quarter-circle arc with a cubic bezier is well-established: the "kappa" constant `κ ≈ 0.5522847498` controls control point placement at `κ × radius` from the corner apex. For this project's fixed 8px corner radius, the offset is `8 × 0.5522847498 ≈ 4.418`.

The input data model from Phase 21 is already well-defined: same-lane edges have `fromX === toX` with `fromY < toY`, cross-lane edges have `fromX !== toX` with `fromY === toY`. The new path builder needs to determine connection direction (merge vs fork) purely from coordinate differences, since `edge_type` was stripped during the Active Lanes transformation.

**Primary recommendation:** Implement `buildOverlayPaths()` as a single pure function in a new `src/lib/overlay-paths.ts` file, using cubic bezier `C` commands for rounded corners with the kappa approximation constant, and comprehensive unit tests following the exact-string-match pattern established in `graph-svg-data.test.ts`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **GitKraken Manhattan style** — not free-form bezier S-curves. Edges consist of: vertical segments, horizontal segments, and 90° rounded corners at bends
- Branch edges: vertical down → rounded 90° turn → horizontal right
- Merge edges: horizontal left → rounded 90° turn → vertical up
- Corner radius: `OVERLAY_LANE_WIDTH / 2` (8px) — fixed, matching current pipeline proportions
- Horizontal segments sit at row midpoint (cy) — overlapping edges distinguished by color only, no vertical offset
- Paths terminate at **dot center** (cx, cy) — dots render on top in z-order
- The "cubic bezier" in CURV-01 refers to using SVG `C` commands for the rounded 90° corners (smoother than SVG arc `A` commands)
- **Fixed corner radius** regardless of row distance — adjacent and distant connections use identical 8px rounding
- Vertical/horizontal segments simply get longer for distant connections
- Rails run **full row extent**: `rowTop(fromY)` to `rowBottom(toY)` for the coalesced edge span
- **Exception at branch tips**: terminate at `cy` (dot center) instead of row boundary
- Dashed flag is **passed through** — path builder generates identical geometry
- **Single entry point**: `buildOverlayPaths(edges: OverlayEdge[]): OverlayPath[]`
- Extend `SvgPathData` with `kind: 'rail' | 'connection'` field
- Pure function, no side effects

### Claude's Discretion
- Exact SVG `C` command control point math for the rounded corners (as long as radius = 8px and corners are 90°)
- Whether to use `C` (cubic bezier) or `Q` (quadratic) for the corner rendering — whichever produces cleaner 90° rounds
- Internal helper organization (coordinate helpers, edge dispatching)
- Test structure and helper factories (follow existing patterns in `active-lanes.test.ts`)
- Edge stroke widths (already defined: `OVERLAY_EDGE_STROKE = 1.5`, `OVERLAY_MERGE_STROKE = 2`)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CURV-01 | Cross-lane edges render as cubic bezier curves (SVG `C` command) with vertical tangent control points | Kappa constant math for 90° quarter-circle bezier approximation; `C` command syntax from MDN; control point placement formula verified |
| CURV-02 | Same-lane connections render as continuous vertical rail lines (one `<path>` per lane run) | Rail path generation using `M cx V y2` pattern; `rowTop`/`rowBottom`/`cy` coordinate helpers; branch tip exception logic |
| CURV-04 | Bezier control points use per-distance tension tuning (adaptive for adjacent vs distant row connections) | CONTEXT.md clarifies this is a **fixed radius** — corner shape identical regardless of distance. Vertical/horizontal segments get longer. No tension tuning needed. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ~5.6 | Type-safe path generation | Project standard |
| Vitest | ^4.1.0 | Unit testing for path `d` string output | Already configured, test patterns established |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | - | - | Zero runtime dependencies — pure math/string operations |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SVG `C` (cubic bezier) | SVG `Q` (quadratic bezier) | Quadratic has fewer control points but can't independently control entry/exit tangents for a 90° corner — cubic is the correct choice |
| SVG `C` (cubic bezier) | SVG `A` (arc) | Arc is simpler for perfect circles but CONTEXT.md explicitly chose `C` for smoother rendering |
| Custom math | d3-shape / bezier.js | Overkill — we only need one formula (quarter-circle approximation with fixed radius) |

## Architecture Patterns

### Recommended Project Structure
```
src/lib/
├── overlay-paths.ts          # buildOverlayPaths() — main entry point
├── overlay-paths.test.ts     # Unit tests with exact d-string assertions
├── types.ts                  # OverlayPath type (extends SvgPathData + kind)
├── graph-constants.ts        # OVERLAY_* constants (already exist)
└── active-lanes.ts           # Input: buildGraphData() (Phase 21, already exists)
```

### Pattern 1: Coordinate Helpers (replicated per module)
**What:** Local `cx()`, `cy()`, `rowTop()`, `rowBottom()` functions using `OVERLAY_*` constants
**When to use:** Always — every path-generating module defines its own coordinate helpers
**Why:** Established codebase pattern (see `graph-svg-data.ts` lines 7-24, `active-lanes.ts` doesn't have these because it works with grid indices)
**Example:**
```typescript
// Source: graph-svg-data.ts pattern, adapted for OVERLAY_* constants
import { OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT } from './graph-constants.js';

const R = OVERLAY_LANE_WIDTH / 2; // 8px corner radius

function cx(col: number): number {
  return col * OVERLAY_LANE_WIDTH + OVERLAY_LANE_WIDTH / 2;
}

function cy(row: number): number {
  return row * OVERLAY_ROW_HEIGHT + OVERLAY_ROW_HEIGHT / 2;
}

function rowTop(row: number): number {
  return row * OVERLAY_ROW_HEIGHT;
}

function rowBottom(row: number): number {
  return (row + 1) * OVERLAY_ROW_HEIGHT;
}
```

### Pattern 2: Edge Classification by Coordinate Comparison
**What:** Classifying edge type purely from coordinate differences (no `edge_type` field)
**When to use:** Always — Phase 21's `OverlayEdge` doesn't carry `edge_type`
**Key insight from Phase 21 (decision [21-01]):** Connection edges use `fromY === toY === rowIndex` — the path builder determines curve direction from coordinate delta.

```typescript
// Rail (same lane): fromX === toX, fromY < toY
if (edge.fromX === edge.toX) {
  // Vertical rail path
}

// Connection (cross lane): fromX !== toX, fromY === toY
if (edge.fromX !== edge.toX) {
  // Manhattan connection with rounded corners
  // Direction: compare fromX vs toX for left/right
  // But which way does the vertical go? See "Direction Determination" below
}
```

### Pattern 3: Pure Function Returning Array
**What:** Single entry point returns flat array of path data
**When to use:** Matches `computeGraphSvgData()` pattern but returns `OverlayPath[]` instead of `Map<string, SvgPathData>`
**Example:**
```typescript
export interface OverlayPath extends SvgPathData {
  kind: 'rail' | 'connection';
}

export function buildOverlayPaths(edges: OverlayEdge[]): OverlayPath[] {
  const paths: OverlayPath[] = [];
  for (const edge of edges) {
    if (edge.fromX === edge.toX) {
      paths.push(buildRailPath(edge));
    } else {
      paths.push(buildConnectionPath(edge));
    }
  }
  return paths;
}
```

### Anti-Patterns to Avoid
- **Shared coordinate helpers module:** Don't extract cx/cy/rowTop/rowBottom into a shared module — the codebase pattern is to replicate them per file (they're trivial 1-liners and different modules may use different constant sets)
- **Adaptive corner radius:** CONTEXT.md explicitly locks the radius to 8px regardless of distance. Don't add distance-based logic
- **Edge type enum reconstruction:** Don't try to infer merge vs fork from OverlayEdge data — the Manhattan path shape is determined entirely by `fromX`, `toX` relative positions
- **Inline path building:** Don't build `d` strings with string concatenation — use template literals for readability (matches legacy pattern)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Quarter-circle bezier math | Manual trial-and-error control points | Kappa constant formula (see below) | Well-established mathematical result, produces visually perfect arcs |
| SVG path parsing for testing | Custom regex parsers | Exact string comparison | Legacy test suite already uses exact `d` string matching — simple and reliable |

**Key insight:** The entire bezier math reduces to a single constant (`κ ≈ 0.5522847498`). The control points for a 90° corner are always at `κ × radius` distance from the corner point along the tangent direction. No iterative computation needed.

## Common Pitfalls

### Pitfall 1: Wrong Control Point Direction for Cubic Bezier Corners
**What goes wrong:** Control points placed incorrectly produce wobbly or kinked curves instead of smooth 90° corners
**Why it happens:** Cubic bezier `C` commands need two control points — one controlling entry tangent, one controlling exit tangent — and their directions must be perpendicular for a 90° turn
**How to avoid:** Use the kappa formula exactly:
- For a corner turning from vertical→horizontal: CP1 extends `κ×r` along the vertical direction, CP2 extends `κ×r` along the horizontal direction
- For a corner turning from horizontal→vertical: CP1 extends `κ×r` along the horizontal direction, CP2 extends `κ×r` along the vertical direction
**Warning signs:** Corners look "pointy" or "bulging" — inspect control point positions

### Pitfall 2: Connection Direction Ambiguity
**What goes wrong:** Without `edge_type`, it's unclear whether a cross-lane edge is a "merge" (horizontal→down→vertical) or "fork" (vertical→up→horizontal)
**Why it happens:** Phase 21 strips `edge_type` and uses `fromY === toY` for all connections
**How to avoid:** Examine the legacy `buildConnectionPath()` carefully:
- **Merge** edges: start at dot center `(cx(fromX), cy(fromY))`, go horizontal to target lane, then curve down to `rowBottom`
- **Fork** edges: start at dot center `(cx(fromX), cy(fromY))`, go horizontal to target lane, then curve up to `rowTop`

The critical insight: in the **new** pipeline, the path builder doesn't know if it's a merge or fork. But it doesn't need to — the connection edge has `fromY === toY`, and the path should go: **horizontal from `cx(fromX)` to `cx(toX)` at `cy(fromY)`**. That's it — it's just a horizontal line at the row midpoint, with rounded corners where the vertical rail meets it.

Wait — actually, re-examining the legacy code more carefully: connections in the legacy pipeline produce paths with **vertical segments** (down to rowBottom for merges, up to rowTop for forks). But in the new overlay pipeline, vertical segments are handled by **separate rail edges** (already coalesced by Phase 21). So the connection edge only needs to produce the **horizontal segment + two rounded corners** where the vertical rails transition to horizontal.

Actually, looking even more carefully at the data model: Phase 21's connection edges have `fromX !== toX` and `fromY === toY`. This represents a single row's worth of horizontal connection. The path needs to:
1. Start at `cx(fromX), cy(fromY)` — the dot/rail center
2. Draw a rounded corner from vertical to horizontal
3. Draw the horizontal segment
4. Draw a rounded corner from horizontal to vertical
5. End at `cx(toX), cy(toY)` — the target lane center

The direction of the vertical segments at each end determines which way the corners curve. This is where the CONTEXT.md Manhattan style matters:
- The edge goes horizontal at cy (row midpoint)
- At the source end: the rail comes from above (vertical down) → turns horizontal
- At the target end: the horizontal → turns into vertical continuing down

**Resolution:** All connections follow the same pattern — they connect at `cy` with horizontal segments. The rounded corners are always "vertical→horizontal" at one end and "horizontal→vertical" at the other.

### Pitfall 3: Floating Point Precision in Test Assertions
**What goes wrong:** Tests using exact string comparison fail due to floating point arithmetic
**Why it happens:** `OVERLAY_LANE_WIDTH / 2 = 8` (exact), but kappa × 8 = 4.418... (irrational). If these values appear in `d` strings, exact matching breaks
**How to avoid:** Round intermediate values to reasonable precision (2-3 decimal places) when embedding in SVG path strings. SVG renderers handle fractional pixels well. Or: design the path segments so only integer/half-integer values appear in the `d` string (feasible since lane width=16 and row height=36 produce integer coordinates)
**Warning signs:** Tests fail intermittently or produce `4.418277998` vs `4.418277997` mismatches

### Pitfall 4: Branch Tip Rail Termination
**What goes wrong:** Rails extend to row boundary at branch tips, creating visual artifacts where the line overshoots the dot
**Why it happens:** Forgetting the branch tip exception from CONTEXT.md
**How to avoid:** The `OverlayEdge` from Phase 21 already handles this — rail edges for branch tips will have appropriate start/end Y values set by `buildGraphData()`. But verify: does Phase 21 set the Y coordinates to handle branch tip termination, or does the path builder need node information?

Looking at the Phase 21 code: `buildGraphData()` uses `flushLane()` which sets `fromY = startY` and `toY = endY`. For branch tips, the lane starts at the branch tip row. The path builder receives grid coordinates (row indices), not pixel coordinates. **The path builder must apply the branch tip exception when converting row indices to pixel Y coordinates.**

But wait — the path builder doesn't know which edges are branch tips. The `OverlayEdge` type doesn't carry `isBranchTip`. The path builder would need either:
1. Access to `OverlayNode[]` to check if start/end rows are branch tips
2. The rail edges to already account for this in their Y coordinates
3. A convention: rail edges always go `rowTop(fromY)` to `rowBottom(toY)`, and branch tip handling is deferred to the renderer

**Recommendation:** Accept `OverlayGraphData` (which includes both `nodes` and `edges`) as input, or add a second parameter. Then check node properties for rail termination.

Actually, re-reading CONTEXT.md: "Rails run full row extent: rowTop(fromY) to rowBottom(toY) for the coalesced edge span. Exception at branch tips: when a rail has no continuation beyond a dot (branch start/end), terminate at cy." This means the path builder needs to know about branch tips.

**Resolution:** Change the API to `buildOverlayPaths(data: OverlayGraphData): OverlayPath[]` or `buildOverlayPaths(edges: OverlayEdge[], nodes: OverlayNode[]): OverlayPath[]`. The node lookup enables branch-tip-aware rail termination.

### Pitfall 5: Confusing "Bezier Tension" with "Corner Radius"
**What goes wrong:** Implementing distance-based "tension tuning" per CURV-04 requirement, when the user explicitly decided against it
**Why it happens:** CURV-04 requirement says "per-distance tension tuning" but CONTEXT.md overrides this with "fixed corner radius regardless of row distance"
**How to avoid:** Follow CONTEXT.md — the "tension" is effectively constant. CURV-04 is satisfied because the tuning is "fixed at 8px for all distances" (the tuning decision has been made)
**Warning signs:** Implementing if/else branches for different distance tiers

## Code Examples

### Cubic Bezier Quarter-Circle Approximation (The Core Math)

Source: Spencer Mortensen's "Approximate a circle with cubic Bézier curves" + MDN SVG Paths tutorial

The standard kappa constant for approximating a quarter-circle with a cubic bezier:
```
κ = 4 * (√2 - 1) / 3 ≈ 0.5522847498
```

For a 90° corner with radius `R = 8`:
- The bezier handle length from the corner point = `κ × R ≈ 4.418`

**Example: Top-right corner (vertical-down → horizontal-right)**
Corner at point `(x, y)`:
```
Start: (x, y - R)         → coming from vertical above
CP1:   (x, y - R + κ*R)   → handle extends downward from start
CP2:   (x + R - κ*R, y)   → handle extends leftward from end
End:   (x + R, y)          → continuing horizontally right
```

In SVG `C` command:
```
C x,(y - R + κ*R)  (x + R - κ*R),y  (x + R),y
```

### Full Connection Path Example

A connection from lane 0 to lane 2 at row 3 (merge-style: horizontal then down):
```typescript
const KAPPA = 0.5522847498;
const R = 8; // OVERLAY_LANE_WIDTH / 2
const K = KAPPA * R; // ≈ 4.418

// Source: lane 0, row 3
const x1 = cx(0); // 8  (0*16 + 8)
const x2 = cx(2); // 40 (2*16 + 8)
const y = cy(3);  // 126 (3*36 + 18)

// Path: dot center → up R → curve right → horizontal → curve down → down R
// But actually for Manhattan: start at cy, go horizontal, that's it
// The vertical segments are covered by rail edges

// Connection path: horizontal at cy with rounded corners at each end
// Left corner: vertical→horizontal turn
// Right corner: horizontal→vertical turn
const d = [
  `M ${x1} ${y}`,           // Start at source dot center
  `H ${x2}`,                // Horizontal to target dot center
].join(' ');
// Wait — this is too simple. Where are the bezier corners?
```

Actually, let me reconsider the path structure more carefully based on the legacy code and CONTEXT.md:

### Connection Path Anatomy (Merge-style: from dot → horizontal → down)

Looking at legacy `buildConnectionPath()` for MergeRight:
```
M x1 mid H hTarget A r r 0 0 1 x2 (mid+r) V rowBottom
```
This is: horizontal from source dot → arc corner → vertical down to row bottom.

In the new pipeline, the equivalent with cubic bezier:
```typescript
// MergeRight equivalent: horizontal right, then curve down
// Start at source lane center, end at target lane center
function buildMergeConnection(fromCol: number, toCol: number, row: number): string {
  const x1 = cx(fromCol);
  const x2 = cx(toCol);
  const y = cy(row);
  const goingRight = toCol > fromCol;

  // Horizontal target: stop R pixels before the target lane center
  const hTarget = goingRight ? x2 - R : x2 + R;

  // Corner: horizontal → vertical (turning downward)
  // Start of curve: (hTarget, y)
  // End of curve: (x2, y + R)
  const cp1x = hTarget + (goingRight ? K : -K);
  const cp1y = y;
  const cp2x = x2;
  const cp2y = y + R - K;
  const endX = x2;
  const endY = y + R;

  return `M ${x1} ${y} H ${hTarget} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${endX} ${endY} V ${rowBottom(row)}`;
}
```

### Connection Path Anatomy (Fork-style: from dot → horizontal → up)

```typescript
// ForkRight equivalent: horizontal right, then curve up
function buildForkConnection(fromCol: number, toCol: number, row: number): string {
  const x1 = cx(fromCol);
  const x2 = cx(toCol);
  const y = cy(row);
  const goingRight = toCol > fromCol;

  const hTarget = goingRight ? x2 - R : x2 + R;

  // Corner: horizontal → vertical (turning upward)
  const cp1x = hTarget + (goingRight ? K : -K);
  const cp1y = y;
  const cp2x = x2;
  const cp2y = y - R + K;
  const endX = x2;
  const endY = y - R;

  return `M ${x1} ${y} H ${hTarget} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${endX} ${endY} V ${rowTop(row)}`;
}
```

### The Direction Problem (Critical Design Decision)

The new pipeline's `OverlayEdge` for connections has `fromX !== toX` and `fromY === toY`. It doesn't know if this is a "merge" or "fork." Both produce horizontal paths at `cy(row)`, but:
- **Merge**: horizontal → curves **down** to `rowBottom` (the incoming rail continues below)
- **Fork**: horizontal → curves **up** to `rowTop` (the rail comes from above)

**How to resolve:** The connection path should go from `cx(fromX), cy(row)` → horizontal → to `cx(toX), cy(row)`. That's just a straight horizontal line. The **rounded corners** are where the vertical rail meets the horizontal connection — but those corners are part of the rail paths, not the connection paths!

Wait, no. Looking at the legacy pipeline more carefully: the connection edge **includes** a vertical segment. The path goes `M cx(from) cy → H → corner → V rowBottom/rowTop`. The rail edges in Phase 21 cover the continuous vertical spans, and the connection edges handle the horizontal + turn + short vertical stub.

**But in the new pipeline**, rails already cover `rowTop(fromY)` to `rowBottom(toY)` for contiguous spans. And connection edges represent single-row horizontal crossings. So there's an overlap concern: if the rail covers the full row vertically, and the connection also has a vertical stub, they'd render on top of each other.

**My recommendation:** The connection edge in the new pipeline should produce **just the horizontal segment plus two rounded corners** — one at each end where horizontal meets vertical. The rail edges handle all vertical movement. This avoids overlap and keeps paths clean.

For the rounded corners at connection endpoints:
- **Source end** (where rail transitions to horizontal): quarter-circle bezier from vertical to horizontal
- **Target end** (where horizontal transitions back to vertical): quarter-circle bezier from horizontal to vertical

Direction is determined by which row the rail connects to above/below:
- Since we don't know merge vs fork from the edge alone, we can look at neighboring nodes or simply use a simpler approach: **all connections are purely horizontal lines from `cx(fromX)` to `cx(toX)` at `cy(row)`**, and the rounding effect happens at the rail ends.

**Actually, the simplest correct approach:** Make connection paths include the corner turns (matching legacy behavior) but make rail paths stop at the corner entry point (not overlap with the turn). This requires coordination between rail and connection path generation.

**Final recommendation:** Follow the legacy `buildConnectionPath()` approach — each connection produces a complete path from `cx(fromX), cy` → horizontal → corner → vertical stub. Then adjust rail paths to terminate at the corner entry point to avoid overlap. The exact details are an implementation choice within Claude's discretion.

### Rail Path Example
```typescript
function buildRailPath(edge: OverlayEdge, isStartTip: boolean, isEndTip: boolean): string {
  const x = cx(edge.fromX); // fromX === toX for rails
  const startY = isStartTip ? cy(edge.fromY) : rowTop(edge.fromY);
  const endY = isEndTip ? cy(edge.toY) : rowBottom(edge.toY);
  return `M ${x} ${startY} V ${endY}`;
}
```

### Test Pattern (Exact String Assertions)
```typescript
// Source: established pattern from graph-svg-data.test.ts
it('produces rail path from rowTop to rowBottom for non-tip edges', () => {
  const edges: OverlayEdge[] = [{
    fromX: 0, fromY: 0, toX: 0, toY: 2,
    colorIndex: 0, dashed: false,
  }];
  const result = buildOverlayPaths(edges, nodes);
  const rails = result.filter(p => p.kind === 'rail');
  expect(rails).toHaveLength(1);
  expect(rails[0].d).toBe(`M ${cx(0)} ${rowTop(0)} V ${rowBottom(2)}`);
  expect(rails[0].colorIndex).toBe(0);
  expect(rails[0].dashed).toBe(false);
  expect(rails[0].kind).toBe('rail');
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SVG `A` (arc) for rounded corners | SVG `C` (cubic bezier) for rounded corners | Phase 22 (this phase) | Smoother rendering, better anti-aliasing |
| Per-row SVG paths with viewBox clipping | Single overlay SVG with continuous paths | Phase 20 (foundation) | Enables multi-row bezier curves |
| `edge_type` field (Merge/Fork/Straight) | Coordinate comparison (`fromX === toX`) | Phase 21 (active lanes) | Simpler data model, path builder infers direction |
| Per-commit edge processing | Coalesced lane spans | Phase 21 (active lanes) | Fewer SVG elements, better performance |

**Key math reference — kappa constant:**
- Standard approximation: `κ = 4(√2 - 1)/3 ≈ 0.5522847498` (max radial drift: 2.7 × 10⁻⁴)
- Better approximation (Spencer Mortensen): `κ ≈ 0.551915024494` (max radial drift: 5.6 × 10⁻⁵)
- **Use the standard approximation** — at 8px radius, the difference is sub-pixel and the standard value is universally recognized

## Open Questions

1. **Connection direction (merge vs fork)**
   - What we know: `OverlayEdge` has `fromX !== toX`, `fromY === toY` for connections. Legacy code uses `edge_type` to determine if the vertical stub goes up (fork) or down (merge).
   - What's unclear: How does the path builder determine vertical direction without `edge_type`?
   - Recommendation: The path builder needs additional context. Options:
     - (a) Add a `direction` or `kind` field to `OverlayEdge` in Phase 21 — minimal change but adds coupling
     - (b) Accept `OverlayGraphData` so the builder can look at nodes to infer direction — more complex but self-contained
     - (c) Produce only horizontal paths for connections (no vertical stubs) and let rails handle all vertical movement — cleanest separation but may leave gaps at corners
     - **Preferred: (c)** — connections are purely horizontal with rounded corners at each end. Rails handle vertical. The rounded corners visually connect the horizontal to the vertical.

2. **Branch tip detection for rail termination**
   - What we know: Rails should terminate at `cy` for branch tips, `rowTop`/`rowBottom` otherwise
   - What's unclear: `OverlayEdge` doesn't carry `isBranchTip`
   - Recommendation: Change function signature to accept `OverlayGraphData` or pass nodes alongside edges. Build a `Set<string>` of `${x},${y}` tip positions for O(1) lookup.

3. **Rounding in `d` strings**
   - What we know: All integer coordinates (lane width 16, row height 36) produce exact integer `cx`/`cy` values. But kappa × 8 = 4.41822... is irrational
   - What's unclear: Whether to round these values and to what precision
   - Recommendation: Round to 2 decimal places for bezier control points. SVG renderers handle this fine. Or: avoid kappa in the `d` string entirely — just hard-code the specific pixel offsets for 8px radius (since radius is fixed, the control point offsets are also fixed constants)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.0 |
| Config file | `vite.config.ts` (test section at lines 24-27) |
| Quick run command | `npx vitest run src/lib/overlay-paths.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CURV-01 | Cross-lane edges produce `C` command paths | unit | `npx vitest run src/lib/overlay-paths.test.ts -x` | ❌ Wave 0 |
| CURV-02 | Same-lane edges produce vertical `M..V` paths | unit | `npx vitest run src/lib/overlay-paths.test.ts -x` | ❌ Wave 0 |
| CURV-04 | Fixed 8px radius for all distances | unit | `npx vitest run src/lib/overlay-paths.test.ts -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/overlay-paths.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/overlay-paths.test.ts` — covers CURV-01, CURV-02, CURV-04
- [ ] `OverlayPath` type definition in `src/lib/types.ts` — extends `SvgPathData` with `kind`

*(No framework install needed — Vitest already configured and working. 62 existing tests pass.)*

## Sources

### Primary (HIGH confidence)
- MDN Web Docs — SVG Paths tutorial (verified 2025-10-30): `C x1 y1, x2 y2, x y` syntax for cubic bezier, `M`, `H`, `V`, `L` commands
- Spencer Mortensen — "Approximate a circle with cubic Bézier curves": kappa constant `κ = 4(√2-1)/3 ≈ 0.5522847498` for quarter-circle approximation
- Pomax — "A Primer on Bézier Curves" section on circular arcs: independent confirmation of kappa constant and control point placement

### Secondary (MEDIUM confidence)
- Existing codebase: `graph-svg-data.ts` legacy `buildConnectionPath()` — verified Manhattan routing pattern with arc commands
- Existing codebase: `active-lanes.ts` `buildGraphData()` — verified input data model (OverlayEdge shape)
- Existing codebase: `graph-svg-data.test.ts` and `active-lanes.test.ts` — verified test patterns (exact string matching, factory helpers)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero dependencies, pure TypeScript, all tools verified working
- Architecture: HIGH — follows established codebase patterns, input/output types well-defined
- Bezier math: HIGH — kappa constant is a well-established mathematical result, verified from multiple independent sources
- Direction determination: MEDIUM — the merge/fork direction issue needs a design decision during implementation, but the options are clear
- Pitfalls: HIGH — based on careful analysis of legacy code and new data model

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable math domain, no external dependencies)
