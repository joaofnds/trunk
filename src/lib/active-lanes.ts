import type { GraphCommit, OverlayNode, OverlayEdge, OverlayGraphData } from './types.js';

interface ActiveLane {
  startY: number;
  colorIndex: number;
  dashed: boolean;
}

function flushLane(
  column: number,
  lane: ActiveLane,
  endY: number,
  edges: OverlayEdge[],
): void {
  if (endY > lane.startY) {
    edges.push({
      fromX: column,
      fromY: lane.startY,
      toX: column,
      toY: endY,
      colorIndex: lane.colorIndex,
      dashed: lane.dashed,
    });
  }
}

export function buildGraphData(
  commits: GraphCommit[],
  maxColumns: number,
): OverlayGraphData {
  const nodes: OverlayNode[] = [];
  const edges: OverlayEdge[] = [];
  const activeLanes = new Map<number, ActiveLane>();

  for (let y = 0; y < commits.length; y++) {
    const commit = commits[y];

    // --- WIP sentinel ---
    if (commit.oid === '__wip__') {
      nodes.push({
        oid: '__wip__',
        x: commit.column,
        y,
        colorIndex: commit.color_index,
        isMerge: false,
        isBranchTip: false,
        isStash: false,
        isWip: true,
      });

      // Find HEAD commit row
      let headRow = -1;
      for (let r = y + 1; r < commits.length; r++) {
        if (commits[r].is_head) {
          headRow = r;
          break;
        }
      }
      if (headRow === -1) {
        headRow = Math.min(y + 1, commits.length - 1);
      }

      // Dashed edges from WIP to HEAD, split around stash rows
      // so the dashed line doesn't pass through hollow stash squares.
      // Skip if headRow === y (degenerate: no commits after WIP).
      if (headRow > y) {
        const wipCol = commit.column;
        const stashRows: number[] = [];
        for (let r = y + 1; r < headRow; r++) {
          if (commits[r].is_stash && commits[r].column === wipCol) {
            stashRows.push(r);
          }
        }

        if (stashRows.length === 0) {
          // No stashes in the way — single edge
          edges.push({
            fromX: wipCol, fromY: y, toX: wipCol, toY: headRow,
            colorIndex: commit.color_index, dashed: true,
          });
        } else {
          // Split around each stash: WIP→stash1, stash1→stash2, ..., stashN→HEAD
          const breakpoints = [y, ...stashRows, headRow];
          for (let i = 0; i < breakpoints.length - 1; i++) {
            edges.push({
              fromX: wipCol, fromY: breakpoints[i], toX: wipCol, toY: breakpoints[i + 1],
              colorIndex: commit.color_index, dashed: true,
            });
          }
        }
      }

      continue; // Skip normal edge processing
    }

    // --- Node for this commit ---
    nodes.push({
      oid: commit.oid,
      x: commit.column,
      y,
      colorIndex: commit.color_index,
      isMerge: commit.is_merge,
      isBranchTip: commit.is_branch_tip,
      isStash: commit.is_stash,
      isWip: false,
    });

    // --- Track which columns have straight edges this row ---
    const columnsWithStraight = new Set<number>();

    // --- Process edges ---
    for (const edge of commit.edges) {
      if (edge.from_column === edge.to_column) {
        // Straight edge — coalesce into active lane
        const col = edge.from_column;
        columnsWithStraight.add(col);

        const existing = activeLanes.get(col);
        if (
          existing &&
          existing.colorIndex === edge.color_index &&
          existing.dashed === edge.dashed
        ) {
          // Continue existing lane — don't emit edge yet
          continue;
        }

        // Flush old lane, start new
        if (existing) {
          flushLane(col, existing, y, edges);
        }
        activeLanes.set(col, {
          startY: y,
          colorIndex: edge.color_index,
          dashed: edge.dashed,
        });
      } else {
        // Connection edge — emit directly (never coalesced)
        edges.push({
          fromX: edge.from_column,
          fromY: y,
          toX: edge.to_column,
          toY: y,
          colorIndex: edge.color_index,
          dashed: edge.dashed,
        });
      }
    }

    // --- Flush lanes that have no straight edge continuing at this row ---
    for (const [col, lane] of activeLanes) {
      if (!columnsWithStraight.has(col)) {
        flushLane(col, lane, y, edges);
        activeLanes.delete(col);
      }
    }
  }

  // --- Flush remaining active lanes ---
  const lastRow = commits.length - 1;
  for (const [col, lane] of activeLanes) {
    flushLane(col, lane, lastRow, edges);
  }

  // --- Post-process: inline stash nodes at parent column ---
  // Stashes are placed to the right of their parent by the Rust backend.
  // Move them visually inline: rewrite the stash node's x to the parent's
  // column, convert the stash rail to the parent column, and remove the
  // fork connection from parent to stash.
  inlineStashNodes(nodes, edges, commits);

  return { nodes, edges, maxColumns };
}

/**
 * Moves stash nodes from their own column to their parent's column so the
 * connector is a straight vertical dashed line instead of a branch curve.
 *
 * Detects the pattern: a fork-out connection from parent column P to stash
 * column C at the parent's row. Rewrites:
 * - Stash node x: C → P
 * - Rail edges in column C that belong to the stash: fromX/toX → P
 * - Removes the fork connection edge from P to C
 */
function inlineStashNodes(
  nodes: OverlayNode[],
  edges: OverlayEdge[],
  commits: GraphCommit[],
): void {
  // Build a set of stash columns and their row ranges
  const stashNodes = nodes.filter(n => n.isStash);
  if (stashNodes.length === 0) return;

  // For each stash, find the fork connection at the parent row that points to it
  for (const stash of stashNodes) {
    const stashCol = stash.x;

    // Find the fork connection: a cross-lane edge where toX === stashCol
    // and the edge is dashed. This is emitted at the parent's row.
    const forkIdx = edges.findIndex(
      e => e.toX === stashCol && e.fromX !== stashCol && e.dashed,
    );
    if (forkIdx === -1) continue; // orphan stash or no fork found

    const fork = edges[forkIdx];
    const parentCol = fork.fromX;

    // Move stash node to parent column
    stash.x = parentCol;

    // Rewrite rail edges in stash column to parent column
    for (const e of edges) {
      if (e.fromX === stashCol && e.toX === stashCol && e.dashed) {
        e.fromX = parentCol;
        e.toX = parentCol;
      }
    }

    // Remove the fork connection edge
    edges.splice(forkIdx, 1);
  }
}
