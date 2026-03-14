import type { GraphCommit, GraphEdge, SvgPathData } from './types.js';
import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS } from './graph-constants.js';

const cornerRadius = LANE_WIDTH / 2;

/** Center X of a lane column */
function cx(col: number): number {
  return col * LANE_WIDTH + LANE_WIDTH / 2;
}

/** Center Y (dot position) for a given row index */
function cy(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** Top Y of a row */
function rowTop(row: number): number {
  return row * ROW_HEIGHT;
}

/** Bottom Y of a row */
function rowBottom(row: number): number {
  return (row + 1) * ROW_HEIGHT;
}

/**
 * Build an SVG path d-string for a connection (merge/fork) edge,
 * using Manhattan routing that matches LaneSvg.svelte exactly.
 */
function buildConnectionPath(edge: GraphEdge, rowIndex: number): string {
  const x1 = cx(edge.from_column);
  const x2 = cx(edge.to_column);
  const r = cornerRadius;
  const goingRight = edge.to_column > edge.from_column;
  const hTarget = goingRight ? x2 - r : x2 + r;
  const mid = cy(rowIndex);

  switch (edge.edge_type) {
    case 'MergeLeft':
    case 'MergeRight': {
      const sweep = goingRight ? 1 : 0;
      return `M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${mid + r} V ${rowBottom(rowIndex)}`;
    }
    case 'ForkLeft':
    case 'ForkRight': {
      const sweep = goingRight ? 0 : 1;
      return `M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${mid - r} V ${rowTop(rowIndex)}`;
    }
    default:
      return '';
  }
}

/** Build a dashed connector path from just below the dot to the bottom of the row. */
function buildSentinelConnector(column: number, rowIndex: number, colorIndex: number): SvgPathData {
  return {
    d: `M ${cx(column)} ${cy(rowIndex) + DOT_RADIUS} V ${rowBottom(rowIndex)}`,
    colorIndex,
    dashed: true,
  };
}

/**
 * Transforms GraphCommit[] into a Map of SVG path data keyed by edge identifiers.
 *
 * Key formats:
 * - Straight edges: `{oid}:straight:{column}`
 * - Connection edges: `{oid}:{edgeType}:{fromCol}:{toCol}`
 * - Incoming rails: `{oid}:rail:{column}`
 * - Sentinel connectors: `{oid}:connector:{column}`
 * - WIP incoming dashed: `{oid}:wip-incoming:{column}` (row below WIP)
 *
 * Stash commits get their lane data from the backend, which marks stash-lane
 * edges with dashed=true. The frontend just reads this flag — same algorithm
 * as normal branches, but rendered with dashed lines.
 *
 * Uses absolute Y coordinates based on row index for viewBox clipping.
 */
export function computeGraphSvgData(
  commits: GraphCommit[],
  _maxColumns: number,
): Map<string, SvgPathData> {
  const paths = new Map<string, SvgPathData>();

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];

    // --- WIP sentinel ---
    if (commit.oid === '__wip__') {
      // WIP connector: from dot to bottom of WIP row
      paths.set(`${commit.oid}:connector:${commit.column}`, buildSentinelConnector(commit.column, rowIndex, commit.color_index));

      // Find the HEAD commit row (the commit with is_head flag).
      // The WIP dashed line extends from the WIP dot through all intermediate
      // rows (stash rows, branch tips) down to the HEAD commit.
      let headRow = -1;
      for (let r = rowIndex + 1; r < commits.length; r++) {
        if (commits[r].is_head) {
          headRow = r;
          break;
        }
      }
      if (headRow === -1) {
        // Fallback: just connect to the next row
        headRow = Math.min(rowIndex + 1, commits.length - 1);
      }

      // Draw dashed segments for every row from WIP down to (and including) HEAD row
      for (let r = rowIndex + 1; r <= headRow && r < commits.length; r++) {
        const targetCommit = commits[r];
        const endY = r === headRow ? cy(r) : rowBottom(r);
        paths.set(`${targetCommit.oid}:wip-incoming:${commit.column}`, {
          d: `M ${cx(commit.column)} ${rowTop(r)} V ${endY}`,
          colorIndex: commit.color_index,
          dashed: true,
        });
      }

      continue;
    }

    // --- All commits (normal + stash) ---
    // Edges come from the backend with dashed=true for stash lanes.
    // Same rendering algorithm for all commits — dashed flag flows through.
    const straightEdges: GraphEdge[] = [];
    const connectionEdges: GraphEdge[] = [];

    for (const edge of commit.edges) {
      if (edge.from_column === edge.to_column) {
        straightEdges.push(edge);
      } else {
        connectionEdges.push(edge);
      }
    }

    // Straight edges: vertical line from row top (or dot center for branch tips) to row bottom
    for (const edge of straightEdges) {
      const isBranchTipOwnColumn = commit.is_branch_tip && edge.from_column === commit.column;
      const startY = isBranchTipOwnColumn ? cy(rowIndex) : rowTop(rowIndex);
      const key = `${commit.oid}:straight:${edge.from_column}`;

      paths.set(key, {
        d: `M ${cx(edge.from_column)} ${startY} V ${rowBottom(rowIndex)}`,
        colorIndex: edge.color_index,
        dashed: edge.dashed,
      });
    }

    // Connection edges: merge/fork with Manhattan routing
    for (const edge of connectionEdges) {
      const key = `${commit.oid}:${edge.edge_type}:${edge.from_column}:${edge.to_column}`;

      paths.set(key, {
        d: buildConnectionPath(edge, rowIndex),
        colorIndex: edge.color_index,
        dashed: edge.dashed,
      });
    }

    // Incoming rail: non-branch-tip commits without a straight edge in their own column
    const needsIncomingRail =
      !commit.is_branch_tip &&
      !straightEdges.some((e) => e.from_column === commit.column);

    if (needsIncomingRail) {
      const key = `${commit.oid}:rail:${commit.column}`;
      // Incoming rail is dashed if the commit itself is a stash
      // (its own-column rail comes from the stash lane)
      paths.set(key, {
        d: `M ${cx(commit.column)} ${rowTop(rowIndex)} V ${cy(rowIndex)}`,
        colorIndex: commit.color_index,
        dashed: commit.is_stash,
      });
    }
  }

  return paths;
}
