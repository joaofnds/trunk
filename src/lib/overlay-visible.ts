import type { OverlayNode, OverlayPath } from './types.js';

export interface VisibleOverlayElements {
  rails: OverlayPath[];
  connections: OverlayPath[];
  dots: OverlayNode[];
}

/**
 * Filters overlay paths and nodes to only those intersecting the visible row range.
 *
 * - Rails: included if path.maxRow >= startRow && path.minRow <= endRow (range intersection)
 * - Connections: same intersection logic (single-row paths where minRow === maxRow)
 * - Dots (nodes): included if node.y >= startRow && node.y <= endRow
 *
 * Returns partitioned output: { rails, connections, dots }
 */
export function getVisibleOverlayElements(
  paths: OverlayPath[],
  nodes: OverlayNode[],
  startRow: number,
  endRow: number,
): VisibleOverlayElements {
  const rails: OverlayPath[] = [];
  const connections: OverlayPath[] = [];

  for (const path of paths) {
    // Range intersection: path overlaps [startRow, endRow]
    if (path.maxRow >= startRow && path.minRow <= endRow) {
      if (path.kind === 'rail') {
        rails.push(path);
      } else {
        connections.push(path);
      }
    }
  }

  const dots = nodes.filter(n => n.y >= startRow && n.y <= endRow);

  return { rails, connections, dots };
}
