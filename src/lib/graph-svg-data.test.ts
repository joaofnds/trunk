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
    is_stash: overrides.is_stash ?? false,
  };
}

function makeEdge(overrides: Partial<GraphEdge> & { edge_type: GraphEdge['edge_type'] }): GraphEdge {
  return {
    from_column: overrides.from_column ?? 0,
    to_column: overrides.to_column ?? 0,
    edge_type: overrides.edge_type,
    color_index: overrides.color_index ?? 0,
    dashed: overrides.dashed ?? false,
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

    it('WIP dashed line extends through intermediate rows to HEAD commit', () => {
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

      // mid1 (row 1) gets dashed pass-through from WIP to bottom of row
      expect(result.has('mid1:wip-incoming:0')).toBe(true);
      expect(result.get('mid1:wip-incoming:0')!.dashed).toBe(true);
      expect(result.get('mid1:wip-incoming:0')!.d).toBe(`M ${cx(0)} ${rowTop(1)} V ${rowBottom(1)}`);

      // head_commit (row 2) gets dashed incoming from WIP ending at dot center
      expect(result.has('head_commit:wip-incoming:0')).toBe(true);
      expect(result.get('head_commit:wip-incoming:0')!.dashed).toBe(true);
      expect(result.get('head_commit:wip-incoming:0')!.d).toBe(`M ${cx(0)} ${rowTop(2)} V ${cy(2)}`);

      // mid1 still gets its normal solid straight edges
      expect(result.has('mid1:straight:0')).toBe(true);
      expect(result.get('mid1:straight:0')!.dashed).toBe(false);
      expect(result.has('mid1:straight:1')).toBe(true);
    });

    it('stash branch tip has dashed own-column straight edge (from backend dashed flag)', () => {
      // Stash at row 0 col 1, parent at row 1 col 0.
      // Backend marks stash lane edges with dashed=true.
      const commits = [
        makeCommit({
          oid: 'stash_abc',
          column: 1,
          color_index: 2,
          is_branch_tip: true,
          is_stash: true,
          parent_oids: ['parent'],
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
        makeCommit({
          oid: 'parent',
          column: 0,
          color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 1, color_index: 2, dashed: true }),
          ],
        }),
      ];
      const result = computeGraphSvgData(commits, 2);

      // Stash's own-column straight edge should be dashed (backend marks it)
      expect(result.has('stash_abc:straight:1')).toBe(true);
      expect(result.get('stash_abc:straight:1')!.dashed).toBe(true);
      // Branch tip: starts from cy (dot center)
      expect(result.get('stash_abc:straight:1')!.d).toBe(`M ${cx(1)} ${cy(0)} V ${rowBottom(0)}`);

      // Pass-through in col 0 is NOT dashed (backend marks it false)
      expect(result.has('stash_abc:straight:0')).toBe(true);
      expect(result.get('stash_abc:straight:0')!.dashed).toBe(false);
    });

    it('ForkRight edge targeting stash column is dashed (from backend)', () => {
      // Stash at row 0 col 1, parent at row 1 col 0.
      const commits = [
        makeCommit({
          oid: 'stash_def',
          column: 1,
          color_index: 2,
          is_branch_tip: true,
          is_stash: true,
          parent_oids: ['parent'],
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
        makeCommit({
          oid: 'parent',
          column: 0,
          color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 1, color_index: 2, dashed: true }),
          ],
        }),
      ];
      const result = computeGraphSvgData(commits, 2);

      // ForkRight targeting stash col 1 should be dashed
      const forkKey = 'parent:ForkRight:0:1';
      expect(result.has(forkKey)).toBe(true);
      expect(result.get(forkKey)!.dashed).toBe(true);

      // Parent's own Straight should NOT be dashed
      expect(result.get('parent:straight:0')!.dashed).toBe(false);
    });

    it('stash pass-through edges in other columns remain solid', () => {
      const commits = [
        makeCommit({
          oid: 'stash_ghi',
          column: 1,
          color_index: 2,
          is_branch_tip: true,
          is_stash: true,
          parent_oids: ['parent'],
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 2, to_column: 2, color_index: 3 }),
          ],
        }),
        makeCommit({
          oid: 'parent',
          column: 0,
          color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
      ];
      const result = computeGraphSvgData(commits, 3);

      // Column 0 and column 2 are NOT dashed (backend marks them false)
      expect(result.get('stash_ghi:straight:0')!.dashed).toBe(false);
      expect(result.get('stash_ghi:straight:2')!.dashed).toBe(false);
      // Column 1 is dashed (backend marks stash lane)
      expect(result.get('stash_ghi:straight:1')!.dashed).toBe(true);
    });

    it('pass-through rail for a stash lane on an intermediate row is dashed', () => {
      // Two stashes on same parent: stash_A at col 1 (row 0), stash_B at col 2 (row 1).
      // Parent at row 2. Backend marks all stash-lane edges dashed.
      const commits = [
        makeCommit({
          oid: 'stash_A',
          column: 1,
          color_index: 5,
          is_branch_tip: true,
          is_stash: true,
          parent_oids: ['parent'],
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 5, dashed: true }),
          ],
        }),
        makeCommit({
          oid: 'stash_B',
          column: 2,
          color_index: 6,
          is_branch_tip: true,
          is_stash: true,
          parent_oids: ['parent'],
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 5, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 2, to_column: 2, color_index: 6, dashed: true }),
          ],
        }),
        makeCommit({
          oid: 'parent',
          column: 0,
          color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 1, color_index: 5, dashed: true }),
            makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 2, color_index: 6, dashed: true }),
          ],
        }),
      ];
      const result = computeGraphSvgData(commits, 3);

      // stash_B's pass-through at col 1 (stash_A lane) should be dashed
      expect(result.get('stash_B:straight:1')!.dashed).toBe(true);
      // stash_B's own col 2 should be dashed
      expect(result.get('stash_B:straight:2')!.dashed).toBe(true);
      // col 0 pass-through should NOT be dashed
      expect(result.get('stash_B:straight:0')!.dashed).toBe(false);

      // Both ForkRight edges on parent should be dashed
      expect(result.get('parent:ForkRight:0:1')!.dashed).toBe(true);
      expect(result.get('parent:ForkRight:0:2')!.dashed).toBe(true);
      // Parent's own Straight should NOT be dashed
      expect(result.get('parent:straight:0')!.dashed).toBe(false);
    });

    it('real branch sharing same color as stash is NOT dashed', () => {
      // Backend marks stash edges dashed, but real branch edges remain solid
      // even if they reuse the same column after the stash lane was cleaned up.
      const commits = [
        makeCommit({
          oid: 'stash_x',
          column: 1,
          color_index: 2,
          is_branch_tip: true,
          is_stash: true,
          parent_oids: ['parent'],
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
        makeCommit({
          oid: 'parent',
          column: 0,
          color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 1, color_index: 2, dashed: true }),
          ],
        }),
        makeCommit({
          oid: 'branch_tip',
          column: 1,
          color_index: 2,
          is_branch_tip: true,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2 }),
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
      ];
      const result = computeGraphSvgData(commits, 2);

      // Real branch at col 1, row 2 should NOT be dashed (backend doesn't mark it)
      expect(result.get('branch_tip:straight:1')!.dashed).toBe(false);
    });

    it('non-sentinel paths have dashed=false', () => {
      const commit = makeCommit({
        oid: 'regular',
        column: 0,
        edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
      });
      const result = computeGraphSvgData([commit], 1);
      expect(result.get('regular:straight:0')!.dashed).toBe(false);
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
