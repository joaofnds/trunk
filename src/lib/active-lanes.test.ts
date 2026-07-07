import { describe, expect, it } from "vitest";
import { makeCommit, makeEdge } from "../__tests__/helpers/factories.js";
import { buildGraphData } from "./active-lanes.js";

describe("buildGraphData", () => {
	describe("basic structure", () => {
		it("returns empty nodes/connections for empty input", () => {
			const result = buildGraphData([], 0);
			expect(result).toEqual({ nodes: [], connections: [], maxColumns: 0 });
		});

		it("returns OverlayGraphData with correct maxColumns passthrough", () => {
			const result = buildGraphData([], 5);
			expect(result.maxColumns).toBe(5);
		});

		it("produces one node for a single commit with no parents", () => {
			const commits = [makeCommit({ oid: "abc", column: 0, color_index: 1 })];
			const result = buildGraphData(commits, 1);
			expect(result.nodes).toHaveLength(1);
			expect(result.nodes[0]).toEqual({
				oid: "abc",
				x: 0,
				y: 0,
				colorIndex: 1,
				isMerge: false,
				isBranchTip: false,
				isStash: false,
				isWip: false,
			});
			expect(result.connections).toHaveLength(0);
		});
	});

	describe("node generation", () => {
		it("sets correct x=column, y=rowIndex for each commit", () => {
			const commits = [
				makeCommit({ oid: "a", column: 2, color_index: 3 }),
				makeCommit({ oid: "b", column: 1, color_index: 1 }),
				makeCommit({ oid: "c", column: 0, color_index: 0 }),
			];
			const result = buildGraphData(commits, 3);
			expect(result.nodes).toHaveLength(3);
			expect(result.nodes[0]).toMatchObject({
				oid: "a",
				x: 2,
				y: 0,
				colorIndex: 3,
			});
			expect(result.nodes[1]).toMatchObject({
				oid: "b",
				x: 1,
				y: 1,
				colorIndex: 1,
			});
			expect(result.nodes[2]).toMatchObject({
				oid: "c",
				x: 0,
				y: 2,
				colorIndex: 0,
			});
		});

		it("marks branch tip node with isBranchTip=true", () => {
			const commits = [
				makeCommit({ oid: "tip", column: 0, is_branch_tip: true }),
			];
			const result = buildGraphData(commits, 1);
			expect(result.nodes[0].isBranchTip).toBe(true);
		});

		it("marks merge commit node with isMerge=true", () => {
			const commits = [makeCommit({ oid: "merge", column: 0, is_merge: true })];
			const result = buildGraphData(commits, 1);
			expect(result.nodes[0].isMerge).toBe(true);
		});

		it("marks stash commit node with isStash=true", () => {
			const commits = [
				makeCommit({ oid: "stash1", column: 1, is_stash: true }),
			];
			const result = buildGraphData(commits, 2);
			expect(result.nodes[0].isStash).toBe(true);
		});
	});

	describe("connections (per-parent)", () => {
		it("linear chain: one connection per parent link", () => {
			// A → B → C (each has one parent)
			const commits = [
				makeCommit({
					oid: "A",
					column: 0,
					color_index: 0,
					parent_oids: ["B"],
					edges: [makeEdge({ edge_type: "Straight", to_column: 0 })],
				}),
				makeCommit({
					oid: "B",
					column: 0,
					color_index: 0,
					parent_oids: ["C"],
					edges: [makeEdge({ edge_type: "Straight", to_column: 0 })],
				}),
				makeCommit({ oid: "C", column: 0, color_index: 0 }),
			];
			const result = buildGraphData(commits, 1);

			// 2 connections: A→B, B→C
			expect(result.connections).toHaveLength(2);
			expect(result.connections[0]).toEqual({
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 1,
				colorIndex: 0,
				dashed: false,
			});
			expect(result.connections[1]).toEqual({
				childX: 0,
				childY: 1,
				parentX: 0,
				parentY: 2,
				colorIndex: 0,
				dashed: false,
			});
		});

		it("merge commit produces two connections with correct colors", () => {
			// M (col 0) merges B (col 1) into A (col 0)
			const commits = [
				makeCommit({
					oid: "M",
					column: 0,
					color_index: 0,
					is_merge: true,
					parent_oids: ["A", "B"],
					edges: [
						makeEdge({
							edge_type: "Straight",
							from_column: 0,
							to_column: 0,
							color_index: 0,
						}),
						makeEdge({
							edge_type: "MergeRight",
							from_column: 0,
							to_column: 1,
							color_index: 1,
						}),
					],
				}),
				makeCommit({ oid: "A", column: 0, color_index: 0 }),
				makeCommit({ oid: "B", column: 1, color_index: 1 }),
			];
			const result = buildGraphData(commits, 2);

			expect(result.connections).toHaveLength(2);
			// M→A: same column, color 0
			expect(result.connections).toContainEqual({
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 1,
				colorIndex: 0,
				dashed: false,
			});
			// M→B: cross column, color 1
			expect(result.connections).toContainEqual({
				childX: 0,
				childY: 0,
				parentX: 1,
				parentY: 2,
				colorIndex: 1,
				dashed: false,
			});
		});

		it("fork: cross-column connection uses commit color_index as fallback", () => {
			// B0 (col 1) is a fork child, parent P (col 0)
			// B0 only has Straight(1→1), no edge with to_column=0 → fallback to commit color
			const commits = [
				makeCommit({
					oid: "B0",
					column: 1,
					color_index: 2,
					is_branch_tip: true,
					parent_oids: ["P"],
					edges: [
						makeEdge({
							edge_type: "Straight",
							from_column: 1,
							to_column: 1,
							color_index: 2,
						}),
					],
				}),
				makeCommit({ oid: "P", column: 0, color_index: 0 }),
			];
			const result = buildGraphData(commits, 2);

			expect(result.connections).toHaveLength(1);
			expect(result.connections[0]).toEqual({
				childX: 1,
				childY: 0,
				parentX: 0,
				parentY: 1,
				colorIndex: 2,
				dashed: false,
			});
		});

		it("parent not loaded: connection is skipped", () => {
			const commits = [
				makeCommit({
					oid: "A",
					column: 0,
					parent_oids: ["not_loaded"],
					edges: [makeEdge({ edge_type: "Straight", to_column: 0 })],
				}),
			];
			const result = buildGraphData(commits, 1);
			expect(result.connections).toHaveLength(0);
		});
	});

	describe("WIP handling", () => {
		it("creates WIP node with isWip=true", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({
					oid: "head",
					column: 0,
					is_head: true,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 1);

			expect(result.nodes[0]).toMatchObject({
				oid: "__wip__",
				x: 0,
				y: 0,
				isWip: true,
				isMerge: false,
				isBranchTip: false,
				isStash: false,
			});
		});

		it("produces single dashed connection from WIP to HEAD row", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({
					oid: "head",
					column: 0,
					color_index: 0,
					is_head: true,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 1);

			const wipConns = result.connections.filter(
				(c) => c.dashed && c.childY === 0,
			);
			expect(wipConns).toHaveLength(1);
			expect(wipConns[0]).toEqual({
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 1,
				colorIndex: 0,
				dashed: true,
			});
		});

		it("WIP dashed connection spans through intermediate rows to HEAD", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({
					oid: "mid",
					column: 1,
					color_index: 1,
					is_branch_tip: true,
				}),
				makeCommit({
					oid: "head",
					column: 0,
					color_index: 0,
					is_head: true,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 2);

			const wipConns = result.connections.filter(
				(c) => c.dashed && c.childY === 0,
			);
			expect(wipConns).toHaveLength(1);
			expect(wipConns[0].parentY).toBe(2);
		});

		it("anchors WIP on the first head-chain row when HEAD is detached", () => {
			// Mid-rebase: no row has is_head; local-branch rows sort above the
			// head chain (rebase onto a remote tip).
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({ oid: "m2", column: 1, color_index: 1 }),
				makeCommit({ oid: "m1", column: 1, color_index: 1 }),
				makeCommit({
					oid: "r2",
					column: 0,
					color_index: 0,
					in_head_chain: true,
				}),
				makeCommit({
					oid: "r1",
					column: 0,
					color_index: 0,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 2);

			const wipConns = result.connections.filter(
				(c) => c.dashed && c.childY === 0,
			);
			expect(wipConns).toHaveLength(1);
			expect(wipConns[0].parentY).toBe(3);
		});

		it("emits no WIP connection when no head-chain row is loaded", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({ oid: "some_commit", column: 0, color_index: 0 }),
			];
			const result = buildGraphData(commits, 1);

			const wipConns = result.connections.filter(
				(c) => c.dashed && c.childY === 0,
			);
			expect(wipConns).toHaveLength(0);
		});

		it("WIP skips normal connection processing", () => {
			const commits = [
				makeCommit({
					oid: "__wip__",
					column: 0,
					color_index: 0,
					parent_oids: ["head"],
					edges: [
						makeEdge({ edge_type: "Straight", from_column: 0, to_column: 0 }),
					],
				}),
				makeCommit({
					oid: "head",
					column: 0,
					is_head: true,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 1);

			// Should only have the dashed WIP connection, not a per-parent one
			expect(result.connections).toHaveLength(1);
			expect(result.connections[0].dashed).toBe(true);
		});
	});

	describe("stash splitting", () => {
		it("WIP dashed connection splits around stash in same column", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({
					oid: "stash1",
					column: 0,
					color_index: 0,
					is_stash: true,
				}),
				makeCommit({
					oid: "head",
					column: 0,
					color_index: 0,
					is_head: true,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 1);

			const wipConns = result.connections.filter((c) => c.dashed);
			expect(wipConns).toHaveLength(2);
			// WIP→stash, stash→HEAD
			expect(wipConns[0]).toMatchObject({ childY: 0, parentY: 1 });
			expect(wipConns[1]).toMatchObject({ childY: 1, parentY: 2 });
		});

		it("splits WIP connection around stash when anchored on a detached head-chain row", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({
					oid: "stash1",
					column: 0,
					color_index: 0,
					is_stash: true,
				}),
				makeCommit({
					oid: "r2",
					column: 0,
					color_index: 0,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 1);

			const wipConns = result.connections.filter((c) => c.dashed);
			expect(wipConns).toHaveLength(2);
			expect(wipConns[0]).toMatchObject({ childY: 0, parentY: 1 });
			expect(wipConns[1]).toMatchObject({ childY: 1, parentY: 2 });
		});

		it("stash in different column does not split WIP connection", () => {
			const commits = [
				makeCommit({ oid: "__wip__", column: 0, color_index: 0 }),
				makeCommit({
					oid: "stash1",
					column: 1,
					color_index: 1,
					is_stash: true,
				}),
				makeCommit({
					oid: "head",
					column: 0,
					color_index: 0,
					is_head: true,
					in_head_chain: true,
				}),
			];
			const result = buildGraphData(commits, 2);

			const wipConns = result.connections.filter(
				(c) => c.dashed && c.childY === 0,
			);
			expect(wipConns).toHaveLength(1);
			expect(wipConns[0].parentY).toBe(2);
		});
	});

	describe("stash node", () => {
		it("stash node has isStash=true", () => {
			const commits = [
				makeCommit({
					oid: "stash_abc",
					column: 1,
					color_index: 2,
					is_branch_tip: true,
					is_stash: true,
				}),
			];
			const result = buildGraphData(commits, 2);
			expect(result.nodes[0].isStash).toBe(true);
		});

		it("stash connections are always dashed", () => {
			const commits = [
				makeCommit({
					oid: "stash1",
					column: 1,
					color_index: 2,
					is_branch_tip: true,
					is_stash: true,
					parent_oids: ["parent"],
					edges: [
						makeEdge({
							edge_type: "Straight",
							from_column: 1,
							to_column: 1,
							color_index: 2,
							dashed: true,
						}),
						makeEdge({
							edge_type: "Straight",
							from_column: 0,
							to_column: 0,
							color_index: 0,
						}),
					],
				}),
				makeCommit({ oid: "parent", column: 0, color_index: 0 }),
			];
			const result = buildGraphData(commits, 2);

			const stashConns = result.connections.filter((c) => c.childY === 0);
			expect(stashConns).toHaveLength(1);
			expect(stashConns[0].dashed).toBe(true);
		});
	});
});
