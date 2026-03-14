import type { GraphCommit, OverlayGraphData } from './types.js';

export function buildGraphData(
  commits: GraphCommit[],
  maxColumns: number,
): OverlayGraphData {
  return { nodes: [], edges: [], maxColumns };
}
