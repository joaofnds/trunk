import type { GraphCommit, SvgPathData } from './types.js';

/**
 * Transforms an array of GraphCommits into a Map of SVG path data,
 * keyed by edge identifier strings.
 *
 * This is a stub -- returns empty Map for TDD RED phase.
 */
export function computeGraphSvgData(
  _commits: GraphCommit[],
  _maxColumns: number,
): Map<string, SvgPathData> {
  return new Map();
}
