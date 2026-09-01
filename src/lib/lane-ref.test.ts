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
		...o,
	} as GraphCommit;
}

describe("laneRefForRow", () => {
	it("names the ref at the top of the hovered row's lane", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef()] }),
			makeCommit({ oid: "B", column: 0 }),
			makeCommit({ oid: "C", column: 0 }),
		];

		expect(laneRefForRow(commits, 2)?.short_name).toBe("main");
	});

	it("names the nearest ref above, not the oldest", () => {
		const commits = [
			makeCommit({
				oid: "A",
				column: 0,
				refs: [makeRef({ short_name: "old", name: "refs/heads/old" })],
			}),
			makeCommit({
				oid: "B",
				column: 0,
				refs: [makeRef({ short_name: "near", name: "refs/heads/near" })],
			}),
			makeCommit({ oid: "C", column: 0 }),
		];

		expect(laneRefForRow(commits, 2)?.short_name).toBe("near");
	});

	it("stays inside the hovered row's own lane", () => {
		// The nearer ref belongs to another column. Taking it would name a branch
		// the hovered commit is not on.
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef()] }),
			makeCommit({
				oid: "B",
				column: 1,
				refs: [makeRef({ short_name: "other", name: "refs/heads/other" })],
			}),
			makeCommit({ oid: "C", column: 0 }),
		];

		expect(laneRefForRow(commits, 2)?.short_name).toBe("main");
	});

	it("a row carrying its own ref names that ref", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0, refs: [makeRef()] }),
			makeCommit({
				oid: "B",
				column: 0,
				refs: [makeRef({ short_name: "own", name: "refs/heads/own" })],
			}),
		];

		expect(laneRefForRow(commits, 1)?.short_name).toBe("own");
	});

	it("prefers the same ref the pill shows when a row carries several", () => {
		// sortRefs order: HEAD first, then LocalBranch > Tag > Stash > RemoteBranch.
		const commits = [
			makeCommit({
				oid: "A",
				column: 0,
				refs: [
					makeRef({
						short_name: "origin/main",
						name: "refs/remotes/origin/main",
						ref_type: "RemoteBranch",
					}),
					makeRef(),
				],
			}),
			makeCommit({ oid: "B", column: 0 }),
		];

		expect(laneRefForRow(commits, 1)?.short_name).toBe("main");
	});

	it("is nothing when no ref sits above on this lane", () => {
		const commits = [
			makeCommit({ oid: "A", column: 0 }),
			makeCommit({ oid: "B", column: 0 }),
		];

		expect(laneRefForRow(commits, 1)).toBeUndefined();
	});

	it("ignores a stash, which names a state rather than a line of history", () => {
		const commits = [
			makeCommit({
				oid: "S",
				column: 0,
				is_stash: true,
				refs: [makeRef({ short_name: "stash@{0}", ref_type: "Stash" })],
			}),
			makeCommit({ oid: "B", column: 0 }),
		];

		expect(laneRefForRow(commits, 1)).toBeUndefined();
	});

	it("is nothing for a row that does not exist", () => {
		expect(laneRefForRow([], 3)).toBeUndefined();
	});
});
