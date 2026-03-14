import type { GraphDisplaySettings, OverlayEdge, OverlayGraphData, OverlayNode, OverlayPath } from './types.js';
import { DEFAULT_GRAPH_SETTINGS } from './graph-constants.js';

// ─── Coordinate context ───────────────────────────────────────────────────────

/** Pre-computed coordinate helpers derived from display settings. */
interface PathContext {
  cx: (col: number) => number;
  cy: (row: number) => number;
  rowTop: (row: number) => number;
  rowBottom: (row: number) => number;
  /** Fixed corner radius for cubic bezier connections (= laneWidth / 2) */
  R: number;
  dotRadius: number;
}

function makePathContext(s: GraphDisplaySettings): PathContext {
  const { rowHeight, laneWidth, dotRadius } = s;
  return {
    cx: col => col * laneWidth + laneWidth / 2,
    cy: row => row * rowHeight + rowHeight / 2,
    rowTop: row => row * rowHeight,
    rowBottom: row => (row + 1) * rowHeight,
    R: laneWidth / 2,
    dotRadius,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Kappa constant for cubic bezier quarter-circle approximation.
 * κ = 4(√2−1)/3 ≈ 0.5522847498
 * Control point offset = R * κ
 */
const KAPPA = 4 * (Math.SQRT2 - 1) / 3;

/** Gap between rail end and hollow dot edge — matches stroke-dasharray gap (3 3) */
const DASH_GAP = 3;

// ─── Rail path builder ────────────────────────────────────────────────────────

/** Whether a node renders as hollow (stroke-only, no fill) */
function isHollow(node: OverlayNode): boolean {
  return node.isStash || node.isWip || node.isMerge;
}

/**
 * Builds a vertical rail path (M...V) for a same-lane edge.
 *
 * Endpoint awareness:
 * - Start: branch tip → dot center (filled) or dot edge (hollow: stash/WIP/merge)
 *          no node → rowTop (continues from above)
 * - End:   branch tip → dot center (filled) or dot edge (hollow)
 *          no node → cy - R (lane terminates at curve corner)
 *          non-tip node → rowBottom (continues to next row)
 */
function buildRailPath(edge: OverlayEdge, nodes: OverlayNode[], ctx: PathContext): OverlayPath {
  const { cx, cy, rowTop, rowBottom, R, dotRadius } = ctx;
  const col = edge.fromX;

  // Look up nodes at start and end of rail
  const fromNode = nodes.find(n => n.x === col && n.y === edge.fromY);
  // WIP nodes are visual tips (topmost row) even though isBranchTip is false
  const fromIsTip = (fromNode?.isBranchTip || fromNode?.isWip) ?? false;

  const toNode = nodes.find(n => n.x === col && n.y === edge.toY);
  const toHasNode = toNode !== undefined;
  // WIP nodes are visual tips even though isBranchTip is false
  const toIsTip = (toNode?.isBranchTip || toNode?.isWip) ?? false;

  // Start: tip stops at dot edge + dash gap for hollow shapes, dot center for filled
  let startY: number;
  if (fromIsTip) {
    startY = fromNode && isHollow(fromNode) ? cy(edge.fromY) + dotRadius + DASH_GAP : cy(edge.fromY);
  } else {
    startY = rowTop(edge.fromY);
  }

  // End: branch tip stops at dot edge - dash gap for hollow, dot center for filled.
  // No node: lane terminates at connection curve corner (cy - R).
  // Non-tip node: extends to rowBottom for seamless continuation.
  let endY: number;
  if (toIsTip) {
    endY = toNode && isHollow(toNode) ? cy(edge.toY) - dotRadius - DASH_GAP : cy(edge.toY);
  } else if (!toHasNode) {
    endY = cy(edge.toY) - R;
  } else {
    endY = rowBottom(edge.toY);
  }

  // Safety: if hollow-dot adjustments make startY >= endY, the rail has no visible length
  if (startY >= endY) {
    return {
      d: '',
      colorIndex: edge.colorIndex,
      dashed: edge.dashed,
      kind: 'rail',
      minRow: edge.fromY,
      maxRow: edge.toY,
    };
  }

  return {
    d: `M ${cx(col)} ${startY} V ${endY}`,
    colorIndex: edge.colorIndex,
    dashed: edge.dashed,
    kind: 'rail',
    minRow: edge.fromY,
    maxRow: edge.toY,
  };
}

// ─── Connection path builder ──────────────────────────────────────────────────

/**
 * Determines if a connection edge is a merge (corner curves down) or fork (corner curves up).
 *
 * Logic based on rails in the target column:
 * - If a rail in toX STARTS at fromY → merge pattern (branch merging in from side) → curves DOWN
 * - If a rail in toX ENDS at fromY → fork pattern (branch forking off) → curves UP
 * - Fallback: fork (curves UP toward rowTop)
 */
function isMergePattern(edge: OverlayEdge, allEdges: OverlayEdge[]): boolean {
  const row = edge.fromY;
  const targetCol = edge.toX;

  for (const e of allEdges) {
    if (e === edge) continue;
    if (e.fromX !== e.toX) continue; // only rail edges
    if (e.fromX !== targetCol) continue; // only rails in target column

    if (e.fromY === row) {
      // Rail starts at connection row → merge pattern
      return true;
    }
    if (e.toY === row) {
      // Rail ends at connection row → fork pattern
      return false;
    }
  }

  // Fallback: no rail found — default to fork (curves up)
  return false;
}

/**
 * Builds a connection path (cross-lane edge) using Manhattan routing with
 * a cubic bezier rounded 90° corner.
 *
 * Path structure:
 *   M cx(fromX) cy(fromY)
 *   H hTarget               ← stop R before the corner
 *   C cp1x cp1y, cp2x cp2y, cornerX cornerY
 *
 * No vertical tail after the corner — the rail in the target column already
 * covers the vertical area. The bezier arc transitions smoothly from horizontal
 * to vertical, and the rail (drawn separately) provides the vertical continuity.
 * Previously, a `V vTarget` tail extended to rowTop/rowBottom, creating visible
 * stubs past the curve endpoint.
 *
 * Corner direction:
 *   - merge (curves down): corner bends toward higher Y
 *   - fork  (curves up):   corner bends toward lower Y
 */
function buildConnectionPath(edge: OverlayEdge, allEdges: OverlayEdge[], ctx: PathContext): OverlayPath {
  const { cx, cy, R } = ctx;
  const x1 = cx(edge.fromX);
  const x2 = cx(edge.toX);
  const midY = cy(edge.fromY);
  const goingRight = edge.toX > edge.fromX;
  const merge = isMergePattern(edge, allEdges);

  // Horizontal stop point: R before corner in direction of travel
  const hTarget = goingRight ? x2 - R : x2 + R;

  // Horizontal approach sign: +1 for right, -1 for left
  const hSign = goingRight ? 1 : -1;

  // Vertical exit direction: +1 for down (merge), -1 for up (fork)
  const vSign = merge ? 1 : -1;

  // Bezier control points for 90° quarter-circle
  const cp1x = x2 - hSign * R + hSign * KAPPA * R; // approaches corner from horizontal
  const cp1y = midY;
  const cp2x = x2;
  const cp2y = midY + vSign * (1 - KAPPA) * R;     // leaves corner vertically
  const cornerX = x2;
  const cornerY = midY + vSign * R;

  const d = `M ${x1} ${midY} H ${hTarget} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${cornerX} ${cornerY}`;

  return {
    d,
    colorIndex: edge.colorIndex,
    dashed: edge.dashed,
    kind: 'connection',
    minRow: edge.fromY,
    maxRow: edge.fromY,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Transforms OverlayEdge[] into SVG path data for rendering.
 *
 * - Rail edges (fromX === toX): vertical M...V paths, branch-tip aware
 * - Connection edges (fromX !== toX): Manhattan-routed paths with cubic bezier
 *   rounded 90° corners at the target column
 *
 * Pure function, no side effects — same pattern as buildGraphData().
 *
 * @param settings Display settings controlling row/lane dimensions. Defaults to
 *   DEFAULT_GRAPH_SETTINGS. Pass reactive settings from a future user preferences
 *   store to make paths update without code changes.
 */
export function buildOverlayPaths(
  data: OverlayGraphData,
  settings: GraphDisplaySettings = DEFAULT_GRAPH_SETTINGS,
): OverlayPath[] {
  const ctx = makePathContext(settings);
  const { edges, nodes } = data;
  const result: OverlayPath[] = [];

  for (const edge of edges) {
    if (edge.fromX === edge.toX) {
      // Same-lane: rail path
      result.push(buildRailPath(edge, nodes, ctx));
    } else {
      // Cross-lane: connection path with bezier corners
      result.push(buildConnectionPath(edge, edges, ctx));
    }
  }

  return result;
}
