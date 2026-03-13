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
 * - Stash fork: `{parentOid}:stash-fork:{parentCol}:{stashCol}` (on parent row)
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

      // Dashed incoming segment for the next row (rowTop → cy),
      // matching old LaneSvg behavior: dashed line from WIP dot to next row's dot center.
      const nextRow = rowIndex + 1;
      if (nextRow < commits.length) {
        const nextCommit = commits[nextRow];
        paths.set(`${nextCommit.oid}:wip-incoming:${commit.column}`, {
          d: `M ${cx(commit.column)} ${rowTop(nextRow)} V ${cy(nextRow)}`,
          colorIndex: commit.color_index,
          dashed: true,
        });
      }

      continue;
    }

    // --- Stash sentinel ---
    // Stash rows branch right like real branches. The fork (MergeRight-style)
    // is generated on the parent row (see pass 2 below). Here we only generate:
    // - Dashed incoming rail (rowTop → cy) connecting the parent fork to the dot
    // - Dashed connector (cy+r → rowBottom) if next row is also a stash (chain)
    // - Solid pass-through for all straight edges (other lanes)
    if (commit.oid.startsWith('__stash_')) {
      const stashCol = commit.column;

      // Dashed incoming rail to stash dot
      paths.set(`${commit.oid}:rail:${stashCol}`, {
        d: `M ${cx(stashCol)} ${rowTop(rowIndex)} V ${cy(rowIndex)}`,
        colorIndex: commit.color_index,
        dashed: true,
      });

      // Chain consecutive stashes: if next row is also a stash in same column,
      // add dashed connector from this dot to rowBottom
      const nextIdx = rowIndex + 1;
      if (
        nextIdx < commits.length &&
        commits[nextIdx].oid.startsWith('__stash_') &&
        commits[nextIdx].column === stashCol
      ) {
        paths.set(`${commit.oid}:connector:${stashCol}`, buildSentinelConnector(stashCol, rowIndex, commit.color_index));
      }

      // Solid pass-through for all straight edges (parent lane + other lanes)
      for (const edge of commit.edges) {
        if (edge.from_column === edge.to_column) {
          paths.set(`${commit.oid}:straight:${edge.from_column}`, {
            d: `M ${cx(edge.from_column)} ${rowTop(rowIndex)} V ${rowBottom(rowIndex)}`,
            colorIndex: edge.color_index,
          });
        }
      }

      continue;
    }

    // --- Normal commits ---
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
    const needsIncomingRail =
      !commit.is_branch_tip &&
      !straightEdges.some((e) => e.from_column === commit.column);

    if (needsIncomingRail) {
      const key = `${commit.oid}:rail:${commit.column}`;
      paths.set(key, {
        d: `M ${cx(commit.column)} ${rowTop(rowIndex)} V ${cy(rowIndex)}`,
        colorIndex: commit.color_index,
      });
    }
  }

  // --- Pass 2: Generate dashed fork paths for stash groups ---
  // The fork (MergeRight-style) is drawn on the parent row, exactly like
  // real branch forks. Only generated for the first stash in a consecutive group.
  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];
    if (!commit.oid.startsWith('__stash_')) continue;

    // Only process the first stash in a consecutive group
    if (rowIndex > 0 && commits[rowIndex - 1].oid.startsWith('__stash_')) continue;

    const parentRow = rowIndex - 1;
    if (parentRow < 0) continue;

    const parentCommit = commits[parentRow];
    const parentCol = parentCommit.column;
    const stashCol = commit.column;
    if (parentCol === stashCol) continue; // same column, no fork needed

    // Dashed MergeRight on the parent row: from parent dot → horizontal → arc down → rowBottom
    const x1 = cx(parentCol);
    const x2 = cx(stashCol);
    const r = cornerRadius;
    const goingRight = stashCol > parentCol;
    const hTarget = goingRight ? x2 - r : x2 + r;
    const sweep = goingRight ? 1 : 0;
    const mid = cy(parentRow);

    paths.set(`${parentCommit.oid}:stash-fork:${parentCol}:${stashCol}`, {
      d: `M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${mid + r} V ${rowBottom(parentRow)}`,
      colorIndex: commit.color_index,
      dashed: true,
    });
  }

  return paths;
}
