import { describe, it, expect } from 'vitest';
import { buildOverlayPaths } from './overlay-paths.js';
import type { OverlayEdge, OverlayNode, OverlayGraphData, OverlayPath } from './types.js';

// Constants mirrored from graph-constants.ts for assertion computation
const LANE = 16;
const ROW = 36;
const R = LANE / 2; // 8px corner radius
const DOT_R = 6; // DOT_RADIUS from graph-constants
function cx(col: number): number { return col * LANE + LANE / 2; }
function cy(row: number): number { return row * ROW + ROW / 2; }
function rowTop(row: number): number { return row * ROW; }
function rowBottom(row: number): number { return (row + 1) * ROW; }

/** Factory: minimal OverlayEdge */
function makeOverlayEdge(overrides: Partial<OverlayEdge> & { fromX: number; toX: number; fromY: number; toY: number }): OverlayEdge {
  return {
    fromX: overrides.fromX,
    fromY: overrides.fromY,
    toX: overrides.toX,
    toY: overrides.toY,
    colorIndex: overrides.colorIndex ?? 0,
    dashed: overrides.dashed ?? false,
  };
}

/** Factory: minimal OverlayNode */
function makeOverlayNode(overrides: Partial<OverlayNode> & { oid: string; x: number; y: number }): OverlayNode {
  return {
    oid: overrides.oid,
    x: overrides.x,
    y: overrides.y,
    colorIndex: overrides.colorIndex ?? 0,
    isMerge: overrides.isMerge ?? false,
    isBranchTip: overrides.isBranchTip ?? false,
    isStash: overrides.isStash ?? false,
    isWip: overrides.isWip ?? false,
  };
}

/** Build minimal OverlayGraphData */
function makeGraphData(
  edges: OverlayEdge[],
  nodes: OverlayNode[] = [],
  maxColumns = 4,
): OverlayGraphData {
  return { nodes, edges, maxColumns };
}

describe('buildOverlayPaths', () => {
  describe('empty input', () => {
    it('returns empty array for empty edges', () => {
      const result = buildOverlayPaths(makeGraphData([]));
      expect(result).toEqual([]);
    });

    it('returns empty array for empty edges with nodes present', () => {
      const nodes = [makeOverlayNode({ oid: 'a', x: 0, y: 0 })];
      const result = buildOverlayPaths(makeGraphData([], nodes));
      expect(result).toEqual([]);
    });
  });

  describe('rail paths (same-lane edges)', () => {
    it('produces M...V path for basic rail edge (no nodes → ends at curve corner)', () => {
      // Rail from row 0 to row 3, col 0, no nodes → ends at cy(3) - R (curve corner)
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));

      expect(result).toHaveLength(1);
      expect(result[0].d).toBe(`M ${cx(0)} ${rowTop(0)} V ${cy(3) - R}`);
    });

    it('rail has kind=rail', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].kind).toBe('rail');
    });

    it('rail carries colorIndex through', () => {
      const edge = makeOverlayEdge({ fromX: 1, toX: 1, fromY: 0, toY: 1, colorIndex: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].colorIndex).toBe(3);
    });

    it('rail carries dashed flag through', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2, dashed: true });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].dashed).toBe(true);
    });

    it('solid rail has dashed=false', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2, dashed: false });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].dashed).toBe(false);
    });

    it('rail uses rowTop(fromY) as start when no branch tip at fromY', () => {
      // Row 1 to row 3, col 0 — no nodes → starts at rowTop(1), ends at cy(3) - R
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 1, toY: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].d).toBe(`M ${cx(0)} ${rowTop(1)} V ${cy(3) - R}`);
    });

    it('rail starts at cy(fromY) when fromY node is a branch tip', () => {
      // Branch tip at (x=0, y=0) — rail starting at row 0 should begin at cy(0)
      // No node at (0, 2) → ends at cy(2) - R (curve corner)
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 });
      const nodes = [makeOverlayNode({ oid: 'tip', x: 0, y: 0, isBranchTip: true })];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${cy(0)} V ${cy(2) - R}`);
    });

    it('rail ends at cy(toY) when toY node is a branch tip', () => {
      // Branch tip at (x=0, y=2) — rail ending at row 2 should end at cy(2)
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 });
      const nodes = [makeOverlayNode({ oid: 'tip', x: 0, y: 2, isBranchTip: true })];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${rowTop(0)} V ${cy(2)}`);
    });

    it('rail ends at rowBottom(toY) when non-tip node exists at (col, toY)', () => {
      // Non-tip node at (0, 3) → rail extends to rowBottom(3) for seamless continuation
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 3 });
      const nodes = [makeOverlayNode({ oid: 'mid', x: 0, y: 3, isBranchTip: false })];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${rowTop(0)} V ${rowBottom(3)}`);
    });

    it('rail ends at cy(toY) - R when no node at (col, toY) — lane terminates at curve corner', () => {
      // No node at col 1, row 4 → lane terminates at curve corner point
      const edge = makeOverlayEdge({ fromX: 1, toX: 1, fromY: 0, toY: 4 });
      const nodes = [makeOverlayNode({ oid: 'other', x: 0, y: 4 })]; // node in different column
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(1)} ${rowTop(0)} V ${cy(4) - R}`);
    });

    it('rail starts at cy(fromY) and ends at cy(toY) when both ends are branch tips', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 1, toY: 3 });
      const nodes = [
        makeOverlayNode({ oid: 'tipA', x: 0, y: 1, isBranchTip: true }),
        makeOverlayNode({ oid: 'tipB', x: 0, y: 3, isBranchTip: true }),
      ];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${cy(1)} V ${cy(3)}`);
    });

    it('hollow stash tip: rail starts at dot bottom edge (cy + DOT_RADIUS)', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 1, toY: 3, dashed: true });
      const nodes = [
        makeOverlayNode({ oid: 'stash', x: 0, y: 1, isBranchTip: true, isStash: true }),
      ];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${cy(1) + DOT_R} V ${cy(3) - R}`);
    });

    it('hollow merge node: rail ends at dot top edge (cy - DOT_RADIUS)', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 });
      const nodes = [
        makeOverlayNode({ oid: 'merge', x: 0, y: 2, isBranchTip: true, isMerge: true }),
      ];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${rowTop(0)} V ${cy(2) - DOT_R}`);
    });

    it('hollow WIP node: rail starts at dot bottom edge', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2, dashed: true });
      const nodes = [
        makeOverlayNode({ oid: 'wip', x: 0, y: 0, isBranchTip: true, isWip: true }),
      ];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${cy(0) + DOT_R} V ${cy(2) - R}`);
    });

    it('filled normal tip: rail starts at dot center (cy)', () => {
      // Non-hollow branch tip — rail goes through center (filled dot hides it)
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 });
      const nodes = [
        makeOverlayNode({ oid: 'tip', x: 0, y: 0, isBranchTip: true }),
      ];
      const result = buildOverlayPaths(makeGraphData([edge], nodes));
      expect(result[0].d).toBe(`M ${cx(0)} ${cy(0)} V ${cy(2) - R}`);
    });

    it('produces one path per rail edge', () => {
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 }),
        makeOverlayEdge({ fromX: 1, toX: 1, fromY: 0, toY: 3 }),
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      const rails = result.filter(p => p.kind === 'rail');
      expect(rails).toHaveLength(2);
    });

    it('rail in column 2 uses cx(2) for x coordinate', () => {
      const edge = makeOverlayEdge({ fromX: 2, toX: 2, fromY: 0, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      // cx(2) = 2*16 + 8 = 40, no node at (2, 1) → ends at cy(1) - R
      expect(result[0].d).toBe(`M ${cx(2)} ${rowTop(0)} V ${cy(1) - R}`);
    });
  });

  describe('connection paths (cross-lane edges)', () => {
    it('has kind=connection', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].kind).toBe('connection');
    });

    it('connection carries colorIndex through', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 2, fromY: 1, toY: 1, colorIndex: 5 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].colorIndex).toBe(5);
    });

    it('connection carries dashed flag through', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2, dashed: true });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].dashed).toBe(true);
    });

    it('right-going connection d-string starts at cx(fromX), cy(fromY)', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 2, fromY: 1, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].d).toMatch(new RegExp(`^M ${cx(0)} ${cy(1)}`));
    });

    it('connection path contains a cubic bezier C command', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 2, fromY: 1, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].d).toContain('C');
    });

    it('connection path contains a horizontal H segment', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 2, fromY: 1, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].d).toContain('H');
    });

    it('connection path ends at bezier corner (no vertical tail)', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 2, fromY: 1, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      // Path ends at the bezier corner point — no V segment after the C command
      expect(result[0].d).not.toContain('V');
    });

    it('merge-pattern: rail in toX starts at fromY row → corner curves down', () => {
      // Connection from col 0 to col 1, row 2
      // Rail in col 1 starts at row 2 (merge pattern) → corner should curve down
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2 }), // connection
        makeOverlayEdge({ fromX: 1, toX: 1, fromY: 2, toY: 4 }), // rail starts at row 2 = merge
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      const conn = result.find((p: OverlayPath) => p.kind === 'connection')!;
      // Corner Y should be cy(2) + R (curves down) — no V tail
      const cornerY = cy(2) + R;
      expect(conn.d).toContain(`${cx(1)} ${cornerY}`);
      expect(conn.d).not.toContain('V');
    });

    it('fork-pattern: rail in toX ends at fromY row → corner curves up', () => {
      // Connection from col 0 to col 1, row 2
      // Rail in col 1 ends at row 2 (fork pattern) → corner should curve up
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2 }), // connection
        makeOverlayEdge({ fromX: 1, toX: 1, fromY: 0, toY: 2 }), // rail ends at row 2 = fork
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      const conn = result.find((p: OverlayPath) => p.kind === 'connection')!;
      // Corner Y should be cy(2) - R (curves up) — no V tail
      const cornerY = cy(2) - R;
      expect(conn.d).toContain(`${cx(1)} ${cornerY}`);
      expect(conn.d).not.toContain('V');
    });

    it('left-going connection also produces a path with C command', () => {
      const edge = makeOverlayEdge({ fromX: 2, toX: 0, fromY: 1, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].d).toContain('C');
    });

    it('left-going connection starts at cx(fromX), cy(fromY)', () => {
      const edge = makeOverlayEdge({ fromX: 2, toX: 0, fromY: 1, toY: 1 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      // cx(2)=40, cy(1)=39
      expect(result[0].d).toMatch(new RegExp(`^M ${cx(2)} ${cy(1)}`));
    });

    it('uses fixed 8px corner radius regardless of distance (adjacent lanes)', () => {
      // Adjacent: col 0 to col 1 — corner at cx(1)±R
      const edge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      // Horizontal segment ends R before target: H (cx(1) - R) = H (24 - 8) = H 16
      expect(result[0].d).toContain(`H ${cx(1) - R}`);
    });

    it('uses fixed 8px corner radius regardless of distance (distant lanes)', () => {
      // Distant: col 0 to col 5 — corner still at cx(5)±R
      const edge = makeOverlayEdge({ fromX: 0, toX: 5, fromY: 2, toY: 2 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      // H (cx(5) - R) = H (5*16+8 - 8) = H 80
      expect(result[0].d).toContain(`H ${cx(5) - R}`);
    });

    it('multiple connections at same row produce separate paths', () => {
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2 }),
        makeOverlayEdge({ fromX: 0, toX: 2, fromY: 2, toY: 2 }),
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      const conns = result.filter(p => p.kind === 'connection');
      expect(conns).toHaveLength(2);
    });
  });

  describe('fixed radius for all distances (CURV-04)', () => {
    it('adjacent connection (1 column gap) uses R=8 corner', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 3, toY: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      // Corner point is at cx(toX)±R
      expect(result[0].d).toContain(`H ${cx(1) - R}`);
    });

    it('distant connection (5 column gap) uses same R=8 corner', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 5, fromY: 3, toY: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].d).toContain(`H ${cx(5) - R}`);
    });

    it('two connections of different distances produce same corner style', () => {
      const adjacent = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 1, toY: 1 });
      const distant = makeOverlayEdge({ fromX: 0, toX: 8, fromY: 3, toY: 3 });
      const results = buildOverlayPaths(makeGraphData([adjacent, distant]));
      const conns = results.filter(p => p.kind === 'connection');
      // Both should have C command (cubic bezier corner)
      expect(conns[0].d).toContain('C');
      expect(conns[1].d).toContain('C');
    });
  });

  describe('output fields', () => {
    it('all paths have d, colorIndex, dashed, kind fields', () => {
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2 }),
        makeOverlayEdge({ fromX: 0, toX: 1, fromY: 1, toY: 1 }),
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      for (const path of result) {
        expect(path).toHaveProperty('d');
        expect(path).toHaveProperty('colorIndex');
        expect(path).toHaveProperty('dashed');
        expect(path).toHaveProperty('kind');
        expect(typeof path.d).toBe('string');
        expect(path.d.length).toBeGreaterThan(0);
      }
    });

    it('produces both rail and connection paths from mixed edges', () => {
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 3 }), // rail
        makeOverlayEdge({ fromX: 0, toX: 1, fromY: 2, toY: 2 }), // connection
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      expect(result.some(p => p.kind === 'rail')).toBe(true);
      expect(result.some(p => p.kind === 'connection')).toBe(true);
    });
  });

  describe('minRow/maxRow metadata', () => {
    it('rail edge: minRow equals edge.fromY', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 2, toY: 5 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].minRow).toBe(2);
    });

    it('rail edge: maxRow equals edge.toY', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 2, toY: 5 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].maxRow).toBe(5);
    });

    it('connection edge: minRow equals edge.fromY (single-row)', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 3, toY: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].minRow).toBe(3);
    });

    it('connection edge: maxRow equals edge.fromY (single-row)', () => {
      const edge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 3, toY: 3 });
      const result = buildOverlayPaths(makeGraphData([edge]));
      expect(result[0].maxRow).toBe(3);
    });

    it('mixed edges: all paths have minRow and maxRow', () => {
      const edges = [
        makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 10 }), // rail
        makeOverlayEdge({ fromX: 0, toX: 1, fromY: 5, toY: 5 }),   // connection
      ];
      const result = buildOverlayPaths(makeGraphData(edges));
      for (const path of result) {
        expect(typeof path.minRow).toBe('number');
        expect(typeof path.maxRow).toBe('number');
      }
    });
  });

  describe('WIP edges (dashed=true)', () => {
    it('WIP rail produces identical geometry with dashed=true', () => {
      const solidEdge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2, dashed: false });
      const dashedEdge = makeOverlayEdge({ fromX: 0, toX: 0, fromY: 0, toY: 2, dashed: true });

      const solidResult = buildOverlayPaths(makeGraphData([solidEdge]));
      const dashedResult = buildOverlayPaths(makeGraphData([dashedEdge]));

      expect(solidResult[0].d).toBe(dashedResult[0].d);
      expect(dashedResult[0].dashed).toBe(true);
    });

    it('WIP connection produces identical geometry with dashed=true', () => {
      const solidEdge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 1, toY: 1, dashed: false });
      const dashedEdge = makeOverlayEdge({ fromX: 0, toX: 1, fromY: 1, toY: 1, dashed: true });

      const solidResult = buildOverlayPaths(makeGraphData([solidEdge]));
      const dashedResult = buildOverlayPaths(makeGraphData([dashedEdge]));

      expect(solidResult[0].d).toBe(dashedResult[0].d);
      expect(dashedResult[0].dashed).toBe(true);
    });
  });
});
