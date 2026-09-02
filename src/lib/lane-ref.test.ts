import { describe, expect, it } from "vitest";
import { laneRefForRow } from "./lane-ref.js";
import type { GraphCommit, RefLabel } from "./types.js";

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
		short_oid: "x",
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
		lane_ref: null,
		...o,
	} as GraphCommit;
}

describe("laneRefForRow", () => {
	it("names the ref that claimed the row's lane", () => {
		const commits = [makeCommit({ oid: "A", lane_ref: makeRef() })];

		expect(laneRefForRow(commits, 0)?.short_name).toBe("main");
	});

	it("names the lane's ref, not a nearer one the row happens to carry", () => {
		// A tag sitting inside a branch's lane. It draws its own pill on its own row and
		// names nothing: the lane is still the branch's.
		const commits = [
			makeCommit({
				oid: "A",
				refs: [makeRef({ short_name: "v1.0.0", ref_type: "Tag" })],
				lane_ref: makeRef(),
			}),
		];

		expect(laneRefForRow(commits, 0)?.short_name).toBe("main");
	});

	it("is nothing when no ref claimed the row's lane", () => {
		const commits = [makeCommit({ oid: "A" })];

		expect(laneRefForRow(commits, 0)).toBeUndefined();
	});

	it("is nothing for a row that does not exist", () => {
		expect(laneRefForRow([], 3)).toBeUndefined();
	});
});
