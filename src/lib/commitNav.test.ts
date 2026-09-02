import { describe, expect, it } from "vitest";
import { computeCommitNav } from "./commitNav.js";
import type { GraphCommit } from "./types.js";

function commit(oid: string, parentOids: string[] = []): GraphCommit {
	return {
		oid,
		short_oid: oid.slice(0, 7),
		summary: `commit ${oid}`,
		body: null,
		author_name: "Test",
		author_email: "test@test.com",
		author_timestamp: 0,
		parent_oids: parentOids,
		column: 0,
		color_index: 0,
		edges: [],
		refs: [],
		is_head: false,
		is_merge: false,
		is_branch_tip: false,
		is_stash: false,
		in_head_chain: false,
		lane_ref: null,
	};
}

// newest-first list: c is newest, a is oldest. Each commit's parent is the
// next one down (linear history).
const linear: GraphCommit[] = [
	commit("c", ["b"]),
	commit("b", ["a"]),
	commit("a", []),
];

const WIP = commit("__wip__", []);

describe("computeCommitNav", () => {
	it("returns null when nothing is selected", () => {
		expect(computeCommitNav(linear, null, false)).toBeNull();
	});

	it("returns null when the WIP row is selected", () => {
		expect(computeCommitNav([WIP, ...linear], "__wip__", false)).toBeNull();
	});

	it("returns null when the oid is not in the loaded list", () => {
		expect(computeCommitNav(linear, "missing", false)).toBeNull();
	});

	it("computes index/total/newer/older for a mid-history commit", () => {
		const nav = computeCommitNav(linear, "b", false);
		expect(nav).toEqual({
			index: 2,
			total: 3,
			hasMore: false,
			newerOid: "c",
			olderOid: "a",
			childOids: ["c"],
		});
	});

	it("has no newerOid when the newest commit is selected", () => {
		const nav = computeCommitNav(linear, "c", false);
		expect(nav?.index).toBe(1);
		expect(nav?.newerOid).toBeNull();
		expect(nav?.olderOid).toBe("b");
	});

	it("has no olderOid at the loaded tail and reports hasMore", () => {
		const nav = computeCommitNav(linear, "a", true);
		expect(nav?.index).toBe(3);
		expect(nav?.total).toBe(3);
		expect(nav?.hasMore).toBe(true);
		expect(nav?.olderOid).toBeNull();
	});

	it("excludes the WIP row from index/total", () => {
		const nav = computeCommitNav([WIP, ...linear], "c", false);
		expect(nav?.index).toBe(1);
		expect(nav?.total).toBe(3);
		expect(nav?.newerOid).toBeNull();
	});

	it("keeps a single newer/older for a merge commit (pager is linear)", () => {
		// m is a merge with two parents; the pager still steps to its single
		// list-adjacent neighbors.
		const merge: GraphCommit[] = [
			commit("x", ["m"]),
			commit("m", ["b", "side"]),
			commit("b", ["a"]),
		];
		const nav = computeCommitNav(merge, "m", false);
		expect(nav?.newerOid).toBe("x");
		expect(nav?.olderOid).toBe("b");
	});

	it("derives multiple childOids at a branch point", () => {
		// Both featureA and featureB have `base` as a parent.
		const branch: GraphCommit[] = [
			commit("featureA", ["base"]),
			commit("featureB", ["base"]),
			commit("base", []),
		];
		const nav = computeCommitNav(branch, "base", false);
		expect(nav?.childOids).toEqual(["featureA", "featureB"]);
	});
});
