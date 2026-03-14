import { describe, it, expect } from 'vitest';
import { getVisibleOverlayElements } from './overlay-visible.js';
import type { OverlayNode, OverlayPath } from './types.js';

/** Factory: minimal OverlayPath with minRow/maxRow */
function makePath(overrides: {
  kind: 'rail' | 'connection';
  minRow: number;
  maxRow: number;
  colorIndex?: number;
  dashed?: boolean;
}): OverlayPath {
  return {
    d: 'M 0 0 V 100',
    colorIndex: overrides.colorIndex ?? 0,
    dashed: overrides.dashed ?? false,
    kind: overrides.kind,
    minRow: overrides.minRow,
    maxRow: overrides.maxRow,
  };
}

/** Factory: minimal OverlayNode */
function makeNode(overrides: { oid?: string; x?: number; y: number }): OverlayNode {
  return {
    oid: overrides.oid ?? 'abc',
    x: overrides.x ?? 0,
    y: overrides.y,
    colorIndex: 0,
    isMerge: false,
    isBranchTip: false,
    isStash: false,
    isWip: false,
  };
}

describe('getVisibleOverlayElements', () => {
  describe('empty input', () => {
    it('returns empty rails, connections, dots for empty paths and nodes', () => {
      const result = getVisibleOverlayElements([], [], 0, 10);
      expect(result).toEqual({ rails: [], connections: [], dots: [] });
    });

    it('returns empty arrays when only nodes are empty', () => {
      const rail = makePath({ kind: 'rail', minRow: 5, maxRow: 10 });
      const result = getVisibleOverlayElements([rail], [], 5, 10);
      expect(result.dots).toEqual([]);
    });

    it('returns empty arrays when only paths are empty', () => {
      const node = makeNode({ y: 5 });
      const result = getVisibleOverlayElements([], [node], 5, 10);
      expect(result.rails).toEqual([]);
      expect(result.connections).toEqual([]);
    });
  });

  describe('rail visibility (range intersection)', () => {
    it('rail spanning rows 0-10 is included when visible range is [3, 8]', () => {
      const rail = makePath({ kind: 'rail', minRow: 0, maxRow: 10 });
      const result = getVisibleOverlayElements([rail], [], 3, 8);
      expect(result.rails).toHaveLength(1);
    });

    it('rail spanning rows 0-10 is excluded when visible range is [15, 20]', () => {
      const rail = makePath({ kind: 'rail', minRow: 0, maxRow: 10 });
      const result = getVisibleOverlayElements([rail], [], 15, 20);
      expect(result.rails).toHaveLength(0);
    });

    it('rail spanning rows 0-100 is included when visible range is [30, 60] (passes through viewport)', () => {
      const rail = makePath({ kind: 'rail', minRow: 0, maxRow: 100 });
      const result = getVisibleOverlayElements([rail], [], 30, 60);
      expect(result.rails).toHaveLength(1);
    });

    it('rail entirely before visible range is excluded', () => {
      const rail = makePath({ kind: 'rail', minRow: 0, maxRow: 5 });
      const result = getVisibleOverlayElements([rail], [], 10, 20);
      expect(result.rails).toHaveLength(0);
    });

    it('rail exactly at viewport boundary (maxRow === startRow) is included', () => {
      const rail = makePath({ kind: 'rail', minRow: 0, maxRow: 10 });
      const result = getVisibleOverlayElements([rail], [], 10, 20);
      expect(result.rails).toHaveLength(1);
    });

    it('rail exactly at viewport boundary (minRow === endRow) is included', () => {
      const rail = makePath({ kind: 'rail', minRow: 10, maxRow: 20 });
      const result = getVisibleOverlayElements([rail], [], 0, 10);
      expect(result.rails).toHaveLength(1);
    });
  });

  describe('connection visibility', () => {
    it('connection at row 5 is included when visible range is [3, 8]', () => {
      const conn = makePath({ kind: 'connection', minRow: 5, maxRow: 5 });
      const result = getVisibleOverlayElements([conn], [], 3, 8);
      expect(result.connections).toHaveLength(1);
    });

    it('connection at row 5 is excluded when visible range is [10, 20]', () => {
      const conn = makePath({ kind: 'connection', minRow: 5, maxRow: 5 });
      const result = getVisibleOverlayElements([conn], [], 10, 20);
      expect(result.connections).toHaveLength(0);
    });

    it('connection exactly at startRow is included', () => {
      const conn = makePath({ kind: 'connection', minRow: 10, maxRow: 10 });
      const result = getVisibleOverlayElements([conn], [], 10, 20);
      expect(result.connections).toHaveLength(1);
    });

    it('connection exactly at endRow is included', () => {
      const conn = makePath({ kind: 'connection', minRow: 20, maxRow: 20 });
      const result = getVisibleOverlayElements([conn], [], 10, 20);
      expect(result.connections).toHaveLength(1);
    });
  });

  describe('node (dot) visibility', () => {
    it('node at row 5 is included when visible range is [3, 8]', () => {
      const node = makeNode({ y: 5 });
      const result = getVisibleOverlayElements([], [node], 3, 8);
      expect(result.dots).toHaveLength(1);
    });

    it('node at row 5 is excluded when visible range is [10, 20]', () => {
      const node = makeNode({ y: 5 });
      const result = getVisibleOverlayElements([], [node], 10, 20);
      expect(result.dots).toHaveLength(0);
    });

    it('node at startRow is included', () => {
      const node = makeNode({ y: 10 });
      const result = getVisibleOverlayElements([], [node], 10, 20);
      expect(result.dots).toHaveLength(1);
    });

    it('node at endRow is included', () => {
      const node = makeNode({ y: 20 });
      const result = getVisibleOverlayElements([], [node], 10, 20);
      expect(result.dots).toHaveLength(1);
    });
  });

  describe('output partitioning (rails vs connections vs dots)', () => {
    it('rails go into rails array, connections go into connections array', () => {
      const rail = makePath({ kind: 'rail', minRow: 0, maxRow: 10 });
      const conn = makePath({ kind: 'connection', minRow: 5, maxRow: 5 });
      const result = getVisibleOverlayElements([rail, conn], [], 0, 10);
      expect(result.rails).toHaveLength(1);
      expect(result.connections).toHaveLength(1);
      expect(result.rails[0].kind).toBe('rail');
      expect(result.connections[0].kind).toBe('connection');
    });

    it('multiple visible rails are all included', () => {
      const paths = [
        makePath({ kind: 'rail', minRow: 0, maxRow: 5 }),
        makePath({ kind: 'rail', minRow: 3, maxRow: 10 }),
        makePath({ kind: 'rail', minRow: 7, maxRow: 15 }),
      ];
      const result = getVisibleOverlayElements(paths, [], 4, 8);
      expect(result.rails).toHaveLength(3);
    });

    it('out-of-range paths are filtered, in-range are kept', () => {
      const paths = [
        makePath({ kind: 'rail', minRow: 0, maxRow: 5 }),    // excluded
        makePath({ kind: 'rail', minRow: 10, maxRow: 15 }),   // included
        makePath({ kind: 'connection', minRow: 3, maxRow: 3 }), // excluded
        makePath({ kind: 'connection', minRow: 12, maxRow: 12 }), // included
      ];
      const result = getVisibleOverlayElements(paths, [], 10, 15);
      expect(result.rails).toHaveLength(1);
      expect(result.connections).toHaveLength(1);
    });
  });
});
