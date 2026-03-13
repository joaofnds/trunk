import { describe, it, expect } from 'vitest';
import { computeGraphSvgData } from './graph-svg-data.js';
import type { GraphCommit, GraphEdge } from './types.js';
import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS } from './graph-constants.js';

// Constants derived from graph-constants (matching LaneSvg.svelte)
const r = LANE_WIDTH / 2; // cornerRadius = 6

function cx(col: number): number {
  return col * LANE_WIDTH + LANE_WIDTH / 2;
}

function cy(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function rowTop(row: number): number {
  return row * ROW_HEIGHT;
}

function rowBottom(row: number): number {
  return (row + 1) * ROW_HEIGHT;
}

/** Minimal GraphCommit factory */
function makeCommit(overrides: Partial<GraphCommit> & { oid: string }): GraphCommit {
  return {
    oid: overrides.oid,
    short_oid: overrides.oid.slice(0, 7),
    summary: 'test commit',
    body: null,
    author_name: 'Test',
    author_email: 'test@test.com',
    author_timestamp: 0,
    parent_oids: overrides.parent_oids ?? [],
    column: overrides.column ?? 0,
    color_index: overrides.color_index ?? 0,
    edges: overrides.edges ?? [],
    refs: overrides.refs ?? [],
    is_head: overrides.is_head ?? false,
    is_merge: overrides.is_merge ?? false,
    is_branch_tip: overrides.is_branch_tip ?? false,
  };
}

function makeEdge(overrides: Partial<GraphEdge> & { edge_type: GraphEdge['edge_type'] }): GraphEdge {
  return {
    from_column: overrides.from_column ?? 0,
    to_column: overrides.to_column ?? 0,
    edge_type: overrides.edge_type,
    color_index: overrides.color_index ?? 0,
  };
}

describe('computeGraphSvgData', () => {
  it('produces a straight edge path for a non-branch-tip commit', () => {
    const commit = makeCommit({
      oid: 'aaa',
      column: 0,
      edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
    });
    const result = computeGraphSvgData([commit], 1);
    const key = 'aaa:straight:0';
    expect(result.has(key)).toBe(true);
    // Non-branch-tip: from row top to row bottom
    expect(result.get(key)!.d).toBe(`M ${cx(0)} ${rowTop(0)} V ${rowBottom(0)}`);
  });

  it('branch tip straight edge starts from dot center, not row top', () => {
    const commit = makeCommit({
      oid: 'bbb',
      column: 0,
      is_branch_tip: true,
      edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
    });
    const result = computeGraphSvgData([commit], 1);
    const key = 'bbb:straight:0';
    expect(result.has(key)).toBe(true);
    // Branch tip in own column: from cy (dot center) to row bottom
    expect(result.get(key)!.d).toBe(`M ${cx(0)} ${cy(0)} V ${rowBottom(0)}`);
  });

  it('MergeRight edge produces correct Manhattan path', () => {
    // Edge from col 0 to col 1, goingRight=true, sweep=1
    const commit = makeCommit({
      oid: 'ccc',
      column: 0,
      edges: [makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 1, color_index: 1 })],
    });
    const result = computeGraphSvgData([commit], 2);
    const key = 'ccc:MergeRight:0:1';
    expect(result.has(key)).toBe(true);
    const x1 = cx(0);
    const x2 = cx(1);
    const mid = cy(0);
    const hTarget = x2 - r;
    expect(result.get(key)!.d).toBe(`M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 1 ${x2} ${mid + r} V ${rowBottom(0)}`);
    expect(result.get(key)!.colorIndex).toBe(1);
  });

  it('MergeLeft edge produces correct Manhattan path with sweep=0', () => {
    // Edge from col 1 to col 0, goingRight=false, sweep=0
    const commit = makeCommit({
      oid: 'ddd',
      column: 1,
      edges: [makeEdge({ edge_type: 'MergeLeft', from_column: 1, to_column: 0, color_index: 2 })],
    });
    const result = computeGraphSvgData([commit], 2);
    const key = 'ddd:MergeLeft:1:0';
    expect(result.has(key)).toBe(true);
    const x1 = cx(1);
    const x2 = cx(0);
    const mid = cy(0);
    const hTarget = x2 + r;
    expect(result.get(key)!.d).toBe(`M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 0 ${x2} ${mid + r} V ${rowBottom(0)}`);
  });

  it('ForkRight edge produces correct Manhattan path with sweep=0', () => {
    // Edge from col 0 to col 1, goingRight=true, sweep=0
    const commit = makeCommit({
      oid: 'eee',
      column: 0,
      edges: [makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 1, color_index: 3 })],
    });
    const result = computeGraphSvgData([commit], 2);
    const key = 'eee:ForkRight:0:1';
    expect(result.has(key)).toBe(true);
    const x1 = cx(0);
    const x2 = cx(1);
    const mid = cy(0);
    const hTarget = x2 - r;
    expect(result.get(key)!.d).toBe(`M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 0 ${x2} ${mid - r} V ${rowTop(0)}`);
  });

  it('ForkLeft edge produces correct Manhattan path with sweep=1', () => {
    // Edge from col 1 to col 0, goingRight=false, sweep=1
    const commit = makeCommit({
      oid: 'fff',
      column: 1,
      edges: [makeEdge({ edge_type: 'ForkLeft', from_column: 1, to_column: 0, color_index: 4 })],
    });
    const result = computeGraphSvgData([commit], 2);
    const key = 'fff:ForkLeft:1:0';
    expect(result.has(key)).toBe(true);
    const x1 = cx(1);
    const x2 = cx(0);
    const mid = cy(0);
    const hTarget = x2 + r;
    expect(result.get(key)!.d).toBe(`M ${x1} ${mid} H ${hTarget} A ${r} ${r} 0 0 1 ${x2} ${mid - r} V ${rowTop(0)}`);
  });

  it('generates incoming rail for non-branch-tip commit without straight edge in own column', () => {
    // Commit in col 0 with no straight edge in col 0
    const commit = makeCommit({
      oid: 'ggg',
      column: 0,
      is_branch_tip: false,
      edges: [], // no straight edge
    });
    const result = computeGraphSvgData([commit], 1);
    const key = 'ggg:rail:0';
    expect(result.has(key)).toBe(true);
    expect(result.get(key)!.d).toBe(`M ${cx(0)} ${rowTop(0)} V ${cy(0)}`);
  });

  it('does NOT generate incoming rail for branch tips', () => {
    const commit = makeCommit({
      oid: 'hhh',
      column: 0,
      is_branch_tip: true,
      edges: [],
    });
    const result = computeGraphSvgData([commit], 1);
    expect(result.has('hhh:rail:0')).toBe(false);
  });

  it('does NOT generate incoming rail if straight edge exists in own column', () => {
    const commit = makeCommit({
      oid: 'iii',
      column: 0,
      is_branch_tip: false,
      edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
    });
    const result = computeGraphSvgData([commit], 1);
    expect(result.has('iii:rail:0')).toBe(false);
  });

  describe('sentinel path generation', () => {
    it('generates a dashed connector path for __wip__ row', () => {
      const commit = makeCommit({
        oid: '__wip__',
        column: 0,
        color_index: 0,
        edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
      });
      const result = computeGraphSvgData([commit], 1);
      const key = '__wip__:connector:0';
      expect(result.has(key)).toBe(true);
      expect(result.get(key)!.d).toBe(`M ${cx(0)} ${cy(0) + DOT_RADIUS} V ${rowBottom(0)}`);
      expect(result.get(key)!.colorIndex).toBe(0);
      expect(result.get(key)!.dashed).toBe(true);
    });

    it('WIP alone generates only connector path, no straight edges or rails', () => {
      const commit = makeCommit({
        oid: '__wip__',
        column: 0,
        edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
      });
      const result = computeGraphSvgData([commit], 1);
      // Only the connector path (no next row to generate incoming segment for)
      expect(result.size).toBe(1);
      expect(result.has('__wip__:connector:0')).toBe(true);
      expect(result.has('__wip__:straight:0')).toBe(false);
    });

    it('WIP generates dashed incoming segment for the next row', () => {
      const commits = [
        makeCommit({
          oid: '__wip__',
          column: 0,
          color_index: 0,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
        makeCommit({
          oid: 'head_commit',
          column: 0,
          color_index: 0,
          is_head: true,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
      ];
      const result = computeGraphSvgData(commits, 1);

      // WIP connector in row 0
      expect(result.has('__wip__:connector:0')).toBe(true);
      expect(result.get('__wip__:connector:0')!.dashed).toBe(true);

      // Dashed incoming in next row (row 1): from rowTop to cy (dot center)
      const incomingKey = 'head_commit:wip-incoming:0';
      expect(result.has(incomingKey)).toBe(true);
      expect(result.get(incomingKey)!.d).toBe(`M ${cx(0)} ${rowTop(1)} V ${cy(1)}`);
      expect(result.get(incomingKey)!.dashed).toBe(true);
      expect(result.get(incomingKey)!.colorIndex).toBe(0);
    });

    it('WIP dashed incoming does not affect rows beyond the next one', () => {
      const commits = [
        makeCommit({
          oid: '__wip__',
          column: 0,
          color_index: 0,
          edges: [],
        }),
        makeCommit({
          oid: 'mid1',
          column: 1,
          color_index: 1,
          is_branch_tip: true,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 }),
                  makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1 })],
        }),
        makeCommit({
          oid: 'head_commit',
          column: 0,
          color_index: 0,
          is_head: true,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
      ];
      const result = computeGraphSvgData(commits, 2);

      // Only the next row (mid1) gets the dashed incoming
      expect(result.has('mid1:wip-incoming:0')).toBe(true);
      expect(result.get('mid1:wip-incoming:0')!.dashed).toBe(true);

      // Row 2 (head_commit) is NOT affected — no dashed incoming
      expect(result.has('head_commit:wip-incoming:0')).toBe(false);

      // mid1 still gets its normal solid straight edges
      expect(result.has('mid1:straight:0')).toBe(true);
      expect(result.get('mid1:straight:0')!.dashed).toBeUndefined();
      expect(result.has('mid1:straight:1')).toBe(true);
    });

    it('stash generates dashed fork path from parent column to stash column', () => {
      // Stash at column 1, parent lane at column 0
      const commit = makeCommit({
        oid: '__stash_0__',
        column: 1,
        color_index: 0,
        edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
      });
      const result = computeGraphSvgData([commit], 2);
      const key = '__stash_0__:stash-fork:0:1';
      expect(result.has(key)).toBe(true);
      expect(result.get(key)!.dashed).toBe(true);
      expect(result.get(key)!.colorIndex).toBe(0);
      // Fork: from parent column at rowTop → horizontal → arc down → vertical to dot cy
      const x1 = cx(0);
      const x2 = cx(1);
      const hTarget = x2 - r;
      expect(result.get(key)!.d).toBe(
        `M ${x1} ${rowTop(0)} H ${hTarget} A ${r} ${r} 0 0 1 ${x2} ${rowTop(0) + r} V ${cy(0)}`,
      );
    });

    it('stash has solid pass-through edges and no downward connector', () => {
      const commit = makeCommit({
        oid: '__stash_0__',
        column: 1,
        color_index: 0,
        edges: [
          makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 }),
          makeEdge({ edge_type: 'Straight', from_column: 2, to_column: 2, color_index: 3 }),
        ],
      });
      const result = computeGraphSvgData([commit], 3);
      // Solid pass-through in parent column 0
      expect(result.has('__stash_0__:straight:0')).toBe(true);
      expect(result.get('__stash_0__:straight:0')!.dashed).toBeUndefined();
      // Solid pass-through in column 2
      expect(result.has('__stash_0__:straight:2')).toBe(true);
      expect(result.get('__stash_0__:straight:2')!.colorIndex).toBe(3);
      // No downward connector (stash is a leaf)
      expect(result.has('__stash_0__:connector:1')).toBe(false);
    });

    it('stash at rowIndex=2 uses correct Y coordinates for fork', () => {
      const commits = [
        makeCommit({
          oid: 'aaa',
          column: 0,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
        makeCommit({
          oid: 'bbb',
          column: 0,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
        makeCommit({
          oid: '__stash_0__',
          column: 1,
          color_index: 0,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
      ];
      const result = computeGraphSvgData(commits, 2);
      const key = '__stash_0__:stash-fork:0:1';
      expect(result.has(key)).toBe(true);
      const x1 = cx(0);
      const x2 = cx(1);
      const hTarget = x2 - r;
      expect(result.get(key)!.d).toBe(
        `M ${x1} ${rowTop(2)} H ${hTarget} A ${r} ${r} 0 0 1 ${x2} ${rowTop(2) + r} V ${cy(2)}`,
      );
    });

    it('non-sentinel paths do NOT have dashed property set', () => {
      const commit = makeCommit({
        oid: 'regular',
        column: 0,
        edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
      });
      const result = computeGraphSvgData([commit], 1);
      expect(result.get('regular:straight:0')!.dashed).toBeUndefined();
    });
  });

  it('does not throw when parent_oid references missing commit', () => {
    const commit = makeCommit({
      oid: 'jjj',
      column: 0,
      parent_oids: ['nonexistent'],
      edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
    });
    expect(() => computeGraphSvgData([commit], 1)).not.toThrow();
  });

  it('produces multiple paths for commit with multiple edges', () => {
    const commit = makeCommit({
      oid: 'kkk',
      column: 0,
      edges: [
        makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 }),
        makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 1, color_index: 1 }),
      ],
    });
    const result = computeGraphSvgData([commit], 2);
    expect(result.has('kkk:straight:0')).toBe(true);
    expect(result.has('kkk:MergeRight:0:1')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('uses correct key format for straight edges', () => {
    const commit = makeCommit({
      oid: 'lll',
      column: 1,
      edges: [makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1 })],
    });
    const result = computeGraphSvgData([commit], 2);
    expect(result.has('lll:straight:1')).toBe(true);
  });

  it('uses correct key format for connection edges', () => {
    const commit = makeCommit({
      oid: 'mmm',
      column: 0,
      edges: [makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 2 })],
    });
    const result = computeGraphSvgData([commit], 3);
    expect(result.has('mmm:ForkRight:0:2')).toBe(true);
  });

  it('preserves colorIndex from edge', () => {
    const commit = makeCommit({
      oid: 'nnn',
      column: 0,
      edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 5 })],
    });
    const result = computeGraphSvgData([commit], 1);
    expect(result.get('nnn:straight:0')!.colorIndex).toBe(5);
  });

  it('incoming rail uses commit colorIndex', () => {
    const commit = makeCommit({
      oid: 'ooo',
      column: 0,
      color_index: 3,
      is_branch_tip: false,
      edges: [],
    });
    const result = computeGraphSvgData([commit], 1);
    expect(result.get('ooo:rail:0')!.colorIndex).toBe(3);
  });
});
