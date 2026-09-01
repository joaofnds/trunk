import { describe, expect, it } from "vitest";
import { buildLaneLabels, laneSpans } from "./lane-labels.js";
import type { GraphCommit, OverlayNode, RefLabel } from "./types.js";

function makeRef(o: Partial<RefLabel> = {}): RefLabel {
	return {
		name: "refs/heads/main",
		short_name: "main",
		ref_type: "LocalBranch",
		color_index: 0,
		is_head: false,
		...o,
	} as RefLabel;
}

function makeCommit(o: Partial<GraphCommit> = {}): GraphCommit {
	return {
		oid: "x",
		summary: "",
		author_name: "",
		author_email: "",
		timestamp: 0,
		column: 0,
		color_index: 0,
		parent_oids: [],
		refs: [],
		is_head: false,
		is_merge: false,
		is_branch_tip: false,
		is_stash: false,
		in_head_chain: false,
		edges: [],
		...o,
	} as GraphCommit;
}

function makeNode(o: Partial<OverlayNode> = {}): OverlayNode {
	return {
		oid: "x",
		x: 0,
		y: 0,
		colorIndex: 0,
		isMerge: false,
		isBranchTip: false,
		isStash: false,
		isWip: false,
		...o,
	};
}

describe("buildLaneLabels", () => {
	it("labels a lane whose ref has scrolled above the viewport", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef()] }),
			makeCommit({ oid: "B", column: 0 }),
			makeCommit({ oid: "C", column: 0 }),
		];
		const nodes = commits.map((c, y) => makeNode({ oid: c.oid, x: 0, y }));
		const paths = [{ column: 0, minRow: 0, maxRow: 2, colorIndex: 0 }];

		const labels = buildLaneLabels(nodes, commits, paths, 1, 2);

		expect(labels).toHaveLength(1);
		expect(labels[0]).toMatchObject({
			column: 0,
			label: "main",
			colorIndex: 0,
		});
	});

	it("omits the label while the ref's own row is visible", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef()] }),
			makeCommit({ oid: "B", column: 0 }),
		];
		const nodes = commits.map((c, y) => makeNode({ oid: c.oid, x: 0, y }));
		const paths = [{ column: 0, minRow: 0, maxRow: 1, colorIndex: 0 }];

		expect(buildLaneLabels(nodes, commits, paths, 0, 1)).toHaveLength(0);
	});

	it("labels every lane that qualifies, not only the head lane", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef({ is_head: true })] }),
			makeCommit({
				oid: "B",
				column: 1,
				refs: [
					makeRef({
						name: "refs/heads/topic",
						short_name: "topic",
						color_index: 1,
					}),
				],
			}),
			makeCommit({ oid: "C", column: 0 }),
			makeCommit({ oid: "D", column: 1 }),
		];
		const nodes = commits.map((c, y) =>
			makeNode({ oid: c.oid, x: c.column, y }),
		);
		const paths = [
			{ column: 0, minRow: 0, maxRow: 3, colorIndex: 0 },
			{ column: 1, minRow: 1, maxRow: 3, colorIndex: 1 },
		];

		const labels = buildLaneLabels(nodes, commits, paths, 2, 3);

		expect(labels.map((l) => l.label).sort()).toEqual(["main", "topic"]);
	});

	it("a lane with several refs takes the highest-priority one", () => {
		// sortRefs order: HEAD first, then LocalBranch > Tag > Stash > RemoteBranch.
		const commits = [
			makeCommit({
				oid: "A",
				column: 0,
				refs: [
					makeRef({
						name: "refs/remotes/origin/main",
						short_name: "origin/main",
						ref_type: "RemoteBranch",
					}),
					makeRef({ name: "refs/heads/main", short_name: "main" }),
				],
			}),
			makeCommit({ oid: "B", column: 0 }),
		];
		const nodes = commits.map((c, y) => makeNode({ oid: c.oid, x: 0, y }));
		const paths = [{ column: 0, minRow: 0, maxRow: 1, colorIndex: 0 }];

		const labels = buildLaneLabels(nodes, commits, paths, 1, 1);

		expect(labels).toHaveLength(1);
		expect(labels[0].label).toBe("main");
	});

	it("does not label a lane that has no ref above the viewport", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0 }),
			makeCommit({ oid: "B", column: 0 }),
		];
		const nodes = commits.map((c, y) => makeNode({ oid: c.oid, x: 0, y }));
		const paths = [{ column: 0, minRow: 0, maxRow: 1, colorIndex: 0 }];

		expect(buildLaneLabels(nodes, commits, paths, 1, 1)).toHaveLength(0);
	});

	it("does not label a lane that does not reach the viewport", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef()] }),
			makeCommit({ oid: "B", column: 0 }),
			makeCommit({ oid: "C", column: 1 }),
		];
		const nodes = commits.map((c, y) =>
			makeNode({ oid: c.oid, x: c.column, y }),
		);
		// The lane ends at row 1, above the viewport.
		const paths = [{ column: 0, minRow: 0, maxRow: 1, colorIndex: 0 }];

		expect(buildLaneLabels(nodes, commits, paths, 2, 2)).toHaveLength(0);
	});

	it("takes the nearest ref above the viewport when a lane has several", () => {
		const commits = [
			makeCommit({
				oid: "A",
				column: 0,
				refs: [makeRef({ name: "refs/heads/old", short_name: "old" })],
			}),
			makeCommit({
				oid: "B",
				column: 0,
				refs: [makeRef({ name: "refs/heads/near", short_name: "near" })],
			}),
			makeCommit({ oid: "C", column: 0 }),
		];
		const nodes = commits.map((c, y) => makeNode({ oid: c.oid, x: 0, y }));
		const paths = [{ column: 0, minRow: 0, maxRow: 2, colorIndex: 0 }];

		const labels = buildLaneLabels(nodes, commits, paths, 2, 2);

		expect(labels).toHaveLength(1);
		expect(labels[0].label).toBe("near");
	});

	it("ignores stash and WIP nodes as label sources", () => {
		const commits = [
			makeCommit({
				oid: "S",
				column: 0,
				is_stash: true,
				refs: [makeRef({ short_name: "stash@{0}", ref_type: "Stash" })],
			}),
			makeCommit({ oid: "B", column: 0 }),
		];
		const nodes = [
			makeNode({ oid: "S", x: 0, y: 0, isStash: true }),
			makeNode({ oid: "B", x: 0, y: 1 }),
		];
		const paths = [{ column: 0, minRow: 0, maxRow: 1, colorIndex: 0 }];

		expect(buildLaneLabels(nodes, commits, paths, 1, 1)).toHaveLength(0);
	});
});

describe("laneSpans", () => {
	it("keeps same-column runs and drops column-crossing ones", () => {
		const spans = laneSpans([
			{
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 5,
				colorIndex: 0,
				dashed: false,
			},
			{
				childX: 1,
				childY: 2,
				parentX: 0,
				parentY: 6,
				colorIndex: 2,
				dashed: false,
			},
		]);

		expect(spans).toEqual([{ column: 0, minRow: 0, maxRow: 5, colorIndex: 0 }]);
	});

	it("orders the span whichever way the connection runs", () => {
		const spans = laneSpans([
			{
				childX: 1,
				childY: 7,
				parentX: 1,
				parentY: 3,
				colorIndex: 1,
				dashed: false,
			},
		]);

		expect(spans[0]).toMatchObject({ minRow: 3, maxRow: 7 });
	});
});
