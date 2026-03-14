import type { OverlayEdge, OverlayGraphData, OverlayNode, OverlayPath } from './types.js';
import { OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT } from './graph-constants.js';

// ─── Coordinate helpers ───────────────────────────────────────────────────────

/** Center X of a swimlane column */
function cx(col: number): number {
  return col * OVERLAY_LANE_WIDTH + OVERLAY_LANE_WIDTH / 2;
}

/** Center Y (dot position) for a given row index */
function cy(row: number): number {
  return row * OVERLAY_ROW_HEIGHT + OVERLAY_ROW_HEIGHT / 2;
}

/** Top Y of a row */
function rowTop(row: number): number {
  return row * OVERLAY_ROW_HEIGHT;
}

/** Bottom Y of a row */
function rowBottom(row: number): number {
  return (row + 1) * OVERLAY_ROW_HEIGHT;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Fixed corner radius for all connections (CURV-04) */
const R = OVERLAY_LANE_WIDTH / 2;

/**
 * Kappa constant for cubic bezier quarter-circle approximation.
 * κ = 4(√2−1)/3 ≈ 0.5522847498
 * Control point offset = R * κ
 */
const KAPPA = 4 * (Math.SQRT2 - 1) / 3;

// ─── Rail path builder ────────────────────────────────────────────────────────

/**
 * Builds a vertical rail path (M...V) for a same-lane edge.
 *
 * Branch tip awareness:
 * - If fromY node is a branch tip in this column → start at cy(fromY) instead of rowTop(fromY)
 * - If toY node is a branch tip in this column → end at cy(toY) instead of rowBottom(toY)
 */
function buildRailPath(edge: OverlayEdge, nodes: OverlayNode[]): OverlayPath {
  const col = edge.fromX;

  // Check if the node at (col, fromY) is a branch tip
  const fromIsBranchTip = nodes.some(n => n.x === col && n.y === edge.fromY && n.isBranchTip);
  // Check if the node at (col, toY) is a branch tip
  const toIsBranchTip = nodes.some(n => n.x === col && n.y === edge.toY && n.isBranchTip);

  const startY = fromIsBranchTip ? cy(edge.fromY) : rowTop(edge.fromY);
  const endY = toIsBranchTip ? cy(edge.toY) : rowBottom(edge.toY);

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
 * cubic bezier rounded 90° corners.
 *
 * Path structure:
 *   M cx(fromX) cy(fromY)
 *   H hTarget               ← stop R before the corner
 *   C cp1x cp1y, cp2x cp2y, cornerX cornerY
 *   V vTarget               ← rowBottom (merge) or rowTop (fork)
 *
 * Corner direction:
 *   - merge (curves down): vTarget = rowBottom, corner bends toward higher Y
 *   - fork  (curves up):   vTarget = rowTop,    corner bends toward lower Y
 */
function buildConnectionPath(edge: OverlayEdge, allEdges: OverlayEdge[]): OverlayPath {
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

  const vTarget = merge ? rowBottom(edge.fromY) : rowTop(edge.fromY);

  const d = `M ${x1} ${midY} H ${hTarget} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${cornerX} ${cornerY} V ${vTarget}`;

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
 */
export function buildOverlayPaths(data: OverlayGraphData): OverlayPath[] {
  const { edges, nodes } = data;
  const result: OverlayPath[] = [];

  for (const edge of edges) {
    if (edge.fromX === edge.toX) {
      // Same-lane: rail path
      result.push(buildRailPath(edge, nodes));
    } else {
      // Cross-lane: connection path with bezier corners
      result.push(buildConnectionPath(edge, edges));
    }
  }

  return result;
}
