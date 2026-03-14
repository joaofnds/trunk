import { describe, it, expect } from 'vitest';
import { buildGraphData } from './active-lanes.js';
import type { GraphCommit, GraphEdge } from './types.js';

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

describe('buildGraphData', () => {
  describe('basic structure', () => {
    it('returns empty nodes/edges for empty input', () => {
      const result = buildGraphData([], 0);
      expect(result).toEqual({ nodes: [], edges: [], maxColumns: 0 });
    });

    it('returns OverlayGraphData with correct maxColumns passthrough', () => {
      const result = buildGraphData([], 5);
      expect(result.maxColumns).toBe(5);
    });

    it('produces one node for a single commit with no edges', () => {
      const commits = [
        makeCommit({ oid: 'abc', column: 0, color_index: 1 }),
      ];
      const result = buildGraphData(commits, 1);
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toEqual({
        oid: 'abc',
        x: 0,
        y: 0,
        colorIndex: 1,
        isMerge: false,
        isBranchTip: false,
        isStash: false,
        isWip: false,
      });
      expect(result.edges).toHaveLength(0);
    });
  });

  describe('node generation', () => {
    it('sets correct x=column, y=rowIndex for each commit', () => {
      const commits = [
        makeCommit({ oid: 'a', column: 2, color_index: 3 }),
        makeCommit({ oid: 'b', column: 1, color_index: 1 }),
        makeCommit({ oid: 'c', column: 0, color_index: 0 }),
      ];
      const result = buildGraphData(commits, 3);
      expect(result.nodes).toHaveLength(3);
      expect(result.nodes[0]).toMatchObject({ oid: 'a', x: 2, y: 0, colorIndex: 3 });
      expect(result.nodes[1]).toMatchObject({ oid: 'b', x: 1, y: 1, colorIndex: 1 });
      expect(result.nodes[2]).toMatchObject({ oid: 'c', x: 0, y: 2, colorIndex: 0 });
    });

    it('marks branch tip node with isBranchTip=true', () => {
      const commits = [
        makeCommit({ oid: 'tip', column: 0, is_branch_tip: true }),
      ];
      const result = buildGraphData(commits, 1);
      expect(result.nodes[0].isBranchTip).toBe(true);
    });

    it('marks merge commit node with isMerge=true', () => {
      const commits = [
        makeCommit({ oid: 'merge', column: 0, is_merge: true }),
      ];
      const result = buildGraphData(commits, 1);
      expect(result.nodes[0].isMerge).toBe(true);
    });

    it('marks stash commit node with isStash=true', () => {
      const commits = [
        makeCommit({ oid: 'stash1', column: 1, is_stash: true }),
      ];
      const result = buildGraphData(commits, 2);
      expect(result.nodes[0].isStash).toBe(true);
    });
  });

  describe('edge coalescing', () => {
    it('coalesces consecutive same-lane straight segments into one edge', () => {
      // 3 commits, all in column 0, same color — should produce 1 edge, not 3
      const commits = [
        makeCommit({ oid: 'a', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
        makeCommit({ oid: 'b', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
        makeCommit({ oid: 'c', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
      ];
      const result = buildGraphData(commits, 1);

      const straightEdges = result.edges.filter(e => e.fromX === e.toX);
      expect(straightEdges).toHaveLength(1);
      expect(straightEdges[0]).toEqual({
        fromX: 0, fromY: 0, toX: 0, toY: 2,
        colorIndex: 0, dashed: false,
      });
    });

    it('breaks coalescing at color change', () => {
      // 4 commits in column 0: first two color 0, last two color 1
      // Need 4 to ensure the new lane has enough rows to produce a second edge
      const commits = [
        makeCommit({ oid: 'a', column: 0, edges: [makeEdge({ edge_type: 'Straight', color_index: 0 })] }),
        makeCommit({ oid: 'b', column: 0, edges: [makeEdge({ edge_type: 'Straight', color_index: 0 })] }),
        makeCommit({ oid: 'c', column: 0, edges: [makeEdge({ edge_type: 'Straight', color_index: 1 })] }),
        makeCommit({ oid: 'd', column: 0, edges: [makeEdge({ edge_type: 'Straight', color_index: 1 })] }),
      ];
      const result = buildGraphData(commits, 1);

      const straightEdges = result.edges.filter(e => e.fromX === e.toX);
      expect(straightEdges).toHaveLength(2);
      // First span: rows 0-2, color 0 (edges at rows 0,1 reach to row 2)
      expect(straightEdges).toContainEqual({
        fromX: 0, fromY: 0, toX: 0, toY: 2,
        colorIndex: 0, dashed: false,
      });
      // Second span: rows 2-3, color 1 (edges at rows 2,3 reach to row 3)
      expect(straightEdges).toContainEqual({
        fromX: 0, fromY: 2, toX: 0, toY: 3,
        colorIndex: 1, dashed: false,
      });
    });

    it('breaks coalescing at dashed change', () => {
      // 4 commits in column 0: first two solid, last two dashed
      const commits = [
        makeCommit({ oid: 'a', column: 0, edges: [makeEdge({ edge_type: 'Straight', dashed: false })] }),
        makeCommit({ oid: 'b', column: 0, edges: [makeEdge({ edge_type: 'Straight', dashed: false })] }),
        makeCommit({ oid: 'c', column: 0, edges: [makeEdge({ edge_type: 'Straight', dashed: true })] }),
        makeCommit({ oid: 'd', column: 0, edges: [makeEdge({ edge_type: 'Straight', dashed: true })] }),
      ];
      const result = buildGraphData(commits, 1);

      const straightEdges = result.edges.filter(e => e.fromX === e.toX);
      expect(straightEdges).toHaveLength(2);
      // First span: rows 0-2, solid (edges at rows 0,1 reach to row 2)
      expect(straightEdges).toContainEqual({
        fromX: 0, fromY: 0, toX: 0, toY: 2,
        colorIndex: 0, dashed: false,
      });
      // Second span: rows 2-3, dashed (edges at rows 2,3 reach to row 3)
      expect(straightEdges).toContainEqual({
        fromX: 0, fromY: 2, toX: 0, toY: 3,
        colorIndex: 0, dashed: true,
      });
    });

    it('flushes active lanes at end of input', () => {
      // 3 commits with straight edges — lane must be flushed after last row
      const commits = [
        makeCommit({ oid: 'a', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
        makeCommit({ oid: 'b', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
        makeCommit({ oid: 'c', column: 0, edges: [makeEdge({ edge_type: 'Straight' })] }),
      ];
      const result = buildGraphData(commits, 1);

      // The coalesced edge should extend to the last row (row 2)
      const straightEdges = result.edges.filter(e => e.fromX === e.toX);
      expect(straightEdges).toHaveLength(1);
      expect(straightEdges[0].toY).toBe(2);
    });

    it('tracks multiple parallel lanes independently', () => {
      // 3 commits with straight edges in both col 0 and col 1
      const commits = [
        makeCommit({
          oid: 'a', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 1 }),
          ],
        }),
        makeCommit({
          oid: 'b', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 1 }),
          ],
        }),
        makeCommit({
          oid: 'c', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 1 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 2);

      const straightEdges = result.edges.filter(e => e.fromX === e.toX);
      expect(straightEdges).toHaveLength(2);
      expect(straightEdges).toContainEqual({
        fromX: 0, fromY: 0, toX: 0, toY: 2,
        colorIndex: 0, dashed: false,
      });
      expect(straightEdges).toContainEqual({
        fromX: 1, fromY: 0, toX: 1, toY: 2,
        colorIndex: 1, dashed: false,
      });
    });
  });

  describe('connection edges', () => {
    it('emits ForkRight connection edge with fromX != toX', () => {
      const commits = [
        makeCommit({
          oid: 'fork', column: 0, edges: [
            makeEdge({ edge_type: 'ForkRight', from_column: 0, to_column: 1, color_index: 2 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 2);

      const connectionEdges = result.edges.filter(e => e.fromX !== e.toX);
      expect(connectionEdges).toHaveLength(1);
      expect(connectionEdges[0]).toMatchObject({
        fromX: 0, toX: 1, colorIndex: 2, dashed: false,
      });
    });

    it('emits MergeLeft connection edge with fromX != toX', () => {
      const commits = [
        makeCommit({
          oid: 'merge', column: 1, edges: [
            makeEdge({ edge_type: 'MergeLeft', from_column: 1, to_column: 0, color_index: 3 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 2);

      const connectionEdges = result.edges.filter(e => e.fromX !== e.toX);
      expect(connectionEdges).toHaveLength(1);
      expect(connectionEdges[0]).toMatchObject({
        fromX: 1, toX: 0, colorIndex: 3, dashed: false,
      });
    });

    it('connection edges are never coalesced — each emitted individually', () => {
      // Two merge edges on the same commit row
      const commits = [
        makeCommit({
          oid: 'octopus', column: 0, is_merge: true, edges: [
            makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 1, color_index: 1 }),
            makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 2, color_index: 2 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 3);

      const connectionEdges = result.edges.filter(e => e.fromX !== e.toX);
      expect(connectionEdges).toHaveLength(2);
    });
  });

  describe('WIP handling', () => {
    it('creates WIP node with isWip=true', () => {
      const commits = [
        makeCommit({ oid: '__wip__', column: 0, color_index: 0 }),
        makeCommit({ oid: 'head', column: 0, is_head: true }),
      ];
      const result = buildGraphData(commits, 1);

      expect(result.nodes[0]).toMatchObject({
        oid: '__wip__', x: 0, y: 0, isWip: true,
        isMerge: false, isBranchTip: false, isStash: false,
      });
    });

    it('produces single dashed edge from WIP to HEAD row', () => {
      const commits = [
        makeCommit({ oid: '__wip__', column: 0, color_index: 0, edges: [] }),
        makeCommit({ oid: 'head', column: 0, color_index: 0, is_head: true }),
      ];
      const result = buildGraphData(commits, 1);

      // WIP creates exactly one dashed edge
      const wipEdges = result.edges.filter(e => e.dashed && e.fromY === 0);
      expect(wipEdges).toHaveLength(1);
      expect(wipEdges[0]).toEqual({
        fromX: 0, fromY: 0, toX: 0, toY: 1,
        colorIndex: 0, dashed: true,
      });
    });

    it('WIP dashed edge spans through intermediate rows to HEAD', () => {
      const commits = [
        makeCommit({ oid: '__wip__', column: 0, color_index: 0, edges: [] }),
        makeCommit({ oid: 'mid', column: 1, color_index: 1, is_branch_tip: true }),
        makeCommit({ oid: 'head', column: 0, color_index: 0, is_head: true }),
      ];
      const result = buildGraphData(commits, 2);

      // Dashed edge from row 0 (WIP) to row 2 (HEAD), not just row 1
      const wipEdges = result.edges.filter(e => e.dashed && e.fromY === 0);
      expect(wipEdges).toHaveLength(1);
      expect(wipEdges[0].toY).toBe(2);
    });

    it('WIP falls back to next row when no HEAD found', () => {
      const commits = [
        makeCommit({ oid: '__wip__', column: 0, color_index: 0, edges: [] }),
        makeCommit({ oid: 'some_commit', column: 0, color_index: 0 }),
      ];
      const result = buildGraphData(commits, 1);

      const wipEdges = result.edges.filter(e => e.dashed && e.fromY === 0);
      expect(wipEdges).toHaveLength(1);
      expect(wipEdges[0].toY).toBe(1);
    });

    it('WIP skips normal edge processing', () => {
      // WIP has edges in its data but they should NOT be processed normally
      const commits = [
        makeCommit({
          oid: '__wip__', column: 0, color_index: 0,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0 })],
        }),
        makeCommit({ oid: 'head', column: 0, is_head: true, edges: [] }),
      ];
      const result = buildGraphData(commits, 1);

      // Should only have the dashed WIP edge, not a coalesced straight edge
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].dashed).toBe(true);
    });
  });

  describe('stash handling', () => {
    it('stash node has isStash=true and dashed edges from backend data', () => {
      const commits = [
        makeCommit({
          oid: 'stash_abc', column: 1, color_index: 2,
          is_branch_tip: true, is_stash: true,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
        makeCommit({
          oid: 'parent', column: 0, color_index: 0,
          edges: [makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 })],
        }),
      ];
      const result = buildGraphData(commits, 2);

      // Node marked as stash
      expect(result.nodes[0].isStash).toBe(true);
    });

    it('stash pass-through edges in other columns remain solid', () => {
      const commits = [
        makeCommit({
          oid: 'stash_x', column: 1, color_index: 2,
          is_branch_tip: true, is_stash: true,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 2, dashed: true }),
            makeEdge({ edge_type: 'Straight', from_column: 2, to_column: 2, color_index: 3 }),
          ],
        }),
        makeCommit({
          oid: 'parent', column: 0, color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 2, to_column: 2, color_index: 3 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 3);

      // Stash lane (col 1) should be dashed
      const stashLane = result.edges.filter(e => e.fromX === 1 && e.toX === 1);
      expect(stashLane.length).toBeGreaterThanOrEqual(1);
      expect(stashLane.every(e => e.dashed)).toBe(true);

      // Pass-through col 0 should be solid (not dashed)
      const col0Lane = result.edges.filter(e => e.fromX === 0 && e.toX === 0);
      expect(col0Lane.length).toBeGreaterThanOrEqual(1);
      expect(col0Lane.every(e => !e.dashed)).toBe(true);

      // Pass-through col 2 should be solid (not dashed)
      const col2Lane = result.edges.filter(e => e.fromX === 2 && e.toX === 2);
      expect(col2Lane.length).toBeGreaterThanOrEqual(1);
      expect(col2Lane.every(e => !e.dashed)).toBe(true);
    });
  });

  describe('combined scenarios', () => {
    it('octopus merge emits multiple connection edges and node has isMerge=true', () => {
      const commits = [
        makeCommit({
          oid: 'octopus', column: 0, is_merge: true, color_index: 0,
          edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 1, color_index: 1 }),
            makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 2, color_index: 2 }),
            makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 3, color_index: 3 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 4);

      // Node is merge
      expect(result.nodes[0].isMerge).toBe(true);

      // 3 connection edges
      const connectionEdges = result.edges.filter(e => e.fromX !== e.toX);
      expect(connectionEdges).toHaveLength(3);
    });

    it('lanes not interrupted by connection edges at same row', () => {
      // Row 0: straight in col 0 + MergeRight from 0 to 1
      // Row 1: straight in col 0
      // The lane in col 0 should be coalesced across both rows (not broken by the merge edge)
      const commits = [
        makeCommit({
          oid: 'a', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'MergeRight', from_column: 0, to_column: 1, color_index: 1 }),
          ],
        }),
        makeCommit({
          oid: 'b', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 2);

      // Col 0 should have 1 coalesced straight edge (not broken by the merge edge)
      const col0Straight = result.edges.filter(e => e.fromX === 0 && e.toX === 0);
      expect(col0Straight).toHaveLength(1);
      expect(col0Straight[0]).toEqual({
        fromX: 0, fromY: 0, toX: 0, toY: 1,
        colorIndex: 0, dashed: false,
      });

      // The merge connection edge should also exist
      const connectionEdges = result.edges.filter(e => e.fromX !== e.toX);
      expect(connectionEdges).toHaveLength(1);
    });

    it('lane terminates when column has no straight edge at a row', () => {
      // Row 0: straight in col 0 and col 1
      // Row 1: straight in col 0 only (col 1 has no edge)
      // Col 1 lane should be flushed at row 1
      const commits = [
        makeCommit({
          oid: 'a', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
            makeEdge({ edge_type: 'Straight', from_column: 1, to_column: 1, color_index: 1 }),
          ],
        }),
        makeCommit({
          oid: 'b', column: 0, edges: [
            makeEdge({ edge_type: 'Straight', from_column: 0, to_column: 0, color_index: 0 }),
          ],
        }),
      ];
      const result = buildGraphData(commits, 2);

      // Col 1 lane should flush at row 1 (only exists at row 0)
      // But since lane only spans 1 row (startY=0, endY=1), it still gets an edge with toY=1
      const col1Edges = result.edges.filter(e => e.fromX === 1 && e.toX === 1);
      expect(col1Edges).toHaveLength(1);
      expect(col1Edges[0].fromY).toBe(0);
      expect(col1Edges[0].toY).toBe(1);
    });
  });
});
