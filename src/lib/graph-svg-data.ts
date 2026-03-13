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
 * - WIP dashed corridor: `{oid}:wip-through:{column}` (rows between WIP and HEAD)
 *
 * Uses absolute Y coordinates based on row index for viewBox clipping.
 */
export function computeGraphSvgData(
  commits: GraphCommit[],
  _maxColumns: number,
): Map<string, SvgPathData> {
  const paths = new Map<string, SvgPathData>();

  // Pre-scan: locate WIP and HEAD rows to build dashed corridor between them.
  // Each row's SVG clips to its own viewBox, so we need per-row dashed segments.
  let wipRow = -1;
  let wipColumn = -1;
  let wipColorIndex = 0;
  let headRow = -1;

  for (let i = 0; i < commits.length; i++) {
    if (commits[i].oid === '__wip__') {
      wipRow = i;
      wipColumn = commits[i].column;
      wipColorIndex = commits[i].color_index;
    }
    if (commits[i].is_head && wipRow >= 0) {
      headRow = i;
      break;
    }
  }
  // If WIP exists but HEAD not found, connect to the next row as fallback
  if (wipRow >= 0 && headRow < 0 && wipRow + 1 < commits.length) {
    headRow = wipRow + 1;
  }

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];

    // Sentinel OIDs: generate dashed connector path instead of skipping
    if (commit.oid === '__wip__') {
      // WIP connector: from dot to bottom of WIP row
      paths.set(`${commit.oid}:connector:${commit.column}`, buildSentinelConnector(commit.column, rowIndex, commit.color_index));

      // Generate dashed segments for each row between WIP and HEAD.
      // Intermediate rows: full row height. HEAD row: top to dot center.
      for (let i = wipRow + 1; i <= headRow && i < commits.length; i++) {
        const targetCommit = commits[i];
        const startY = rowTop(i);
        const endY = i === headRow ? cy(i) : rowBottom(i);
        paths.set(`${targetCommit.oid}:wip-through:${wipColumn}`, {
          d: `M ${cx(wipColumn)} ${startY} V ${endY}`,
          colorIndex: wipColorIndex,
          dashed: true,
        });
      }

      continue; // WIP has no real edges to process
    }

    if (commit.oid.startsWith('__stash_')) {
      paths.set(`${commit.oid}:connector:${commit.column}`, buildSentinelConnector(commit.column, rowIndex, commit.color_index));
      // Fall through to process pass-through edges (other lanes)
    }

    // Check if this row is in the WIP→HEAD dashed corridor
    const isInWipCorridor = wipRow >= 0 && headRow >= 0 && rowIndex > wipRow && rowIndex <= headRow;

    const straightEdges: GraphEdge[] = [];
    const connectionEdges: GraphEdge[] = [];

    for (const edge of commit.edges) {
      if (edge.from_column === edge.to_column) {
        straightEdges.push(edge);
      } else {
        connectionEdges.push(edge);
      }
    }

    // For stash rows, only process pass-through edges (other lanes), skip own column
    const isSentinelStash = commit.oid.startsWith('__stash_');

    // Straight edges: vertical line from row top (or dot center for branch tips) to row bottom
    for (const edge of straightEdges) {
      // Skip stash's own-column straight edge (already handled by connector)
      if (isSentinelStash && edge.from_column === commit.column) continue;
      // Skip solid edges in WIP column within the corridor (dashed takes their place)
      if (isInWipCorridor && edge.from_column === wipColumn) continue;

      const isBranchTipOwnColumn = commit.is_branch_tip && edge.from_column === commit.column;
      const startY = isBranchTipOwnColumn ? cy(rowIndex) : rowTop(rowIndex);
      const key = `${commit.oid}:straight:${edge.from_column}`;
      paths.set(key, {
        d: `M ${cx(edge.from_column)} ${startY} V ${rowBottom(rowIndex)}`,
        colorIndex: edge.color_index,
      });
    }

    // Connection edges: merge/fork with Manhattan routing
    for (const edge of connectionEdges) {
      const key = `${commit.oid}:${edge.edge_type}:${edge.from_column}:${edge.to_column}`;
      paths.set(key, {
        d: buildConnectionPath(edge, rowIndex),
        colorIndex: edge.color_index,
      });
    }

    // Incoming rail: non-branch-tip commits without a straight edge in their own column
    // Stash rows don't need incoming rails (they have a connector instead)
    // WIP corridor rows in the WIP column don't need incoming rails (dashed covers it)
    const needsIncomingRail =
      !isSentinelStash &&
      !commit.is_branch_tip &&
      !straightEdges.some((e) => e.from_column === commit.column) &&
      !(isInWipCorridor && commit.column === wipColumn);

    if (needsIncomingRail) {
      const key = `${commit.oid}:rail:${commit.column}`;
      paths.set(key, {
        d: `M ${cx(commit.column)} ${rowTop(rowIndex)} V ${cy(rowIndex)}`,
        colorIndex: commit.color_index,
      });
    }
  }

  return paths;
}
