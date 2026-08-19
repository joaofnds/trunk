import { describe, expect, it } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	commentsForLine,
	commentsForView,
	resolveViewOid,
	spannedByComment,
	type ViewDescriptor,
} from "./comment-matching.js";
import type { Anchor, ReviewSnapshots, Side, Thread } from "./types.js";

const EMPTY_SNAPSHOTS: ReviewSnapshots = {
	working_tree_snapshot: null,
	index_snapshot: null,
};

function anchor(props: {
	commitOid: string;
	filePath: string;
	side: Side;
	startLine: number;
	endLine: number;
}): Anchor {
	return {
		commit_oid: props.commitOid,
		file_path: props.filePath,
		source: "Diff",
		side: props.side,
		start_line: props.startLine,
		end_line: props.endLine,
	};
}

function lineComment(id: string, a: Anchor): Thread {
	return aThread({ id, text: `comment ${id}`, anchor: a });
}

function commitNote(id: string): Thread {
	return aThread({ id, text: `note ${id}` });
}

describe("resolveViewOid", () => {
	it("resolves a commit view to its commitOid", () => {
		const view: ViewDescriptor = {
			kind: "commit",
			commitOid: "deadbeef",
			snapshots: EMPTY_SNAPSHOTS,
		};

		expect(resolveViewOid(view)).toBe("deadbeef");
	});

	it("resolves an unstaged view to the working_tree_snapshot", () => {
		const view: ViewDescriptor = {
			kind: "unstaged",
			commitOid: null,
			snapshots: { working_tree_snapshot: "wt-oid", index_snapshot: "idx-oid" },
		};

		expect(resolveViewOid(view)).toBe("wt-oid");
	});

	it("resolves a staged view to the index_snapshot", () => {
		const view: ViewDescriptor = {
			kind: "staged",
			commitOid: null,
			snapshots: { working_tree_snapshot: "wt-oid", index_snapshot: "idx-oid" },
		};

		expect(resolveViewOid(view)).toBe("idx-oid");
	});

	it("resolves a conflicted view to null", () => {
		const view: ViewDescriptor = {
			kind: "conflicted",
			commitOid: "deadbeef",
			snapshots: { working_tree_snapshot: "wt-oid", index_snapshot: "idx-oid" },
		};

		expect(resolveViewOid(view)).toBeNull();
	});

	it("resolves an unstaged view to null when the snapshot is absent", () => {
		const view: ViewDescriptor = {
			kind: "unstaged",
			commitOid: null,
			snapshots: EMPTY_SNAPSHOTS,
		};

		expect(resolveViewOid(view)).toBeNull();
	});
});

describe("commentsForView", () => {
	const FILE = "src/main.ts";

	function commitView(commitOid: string): ViewDescriptor {
		return { kind: "commit", commitOid, snapshots: EMPTY_SNAPSHOTS };
	}

	it("returns a comment whose anchor OID and file_path match the commit view", () => {
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "deadbeef",
				filePath: FILE,
				side: "New",
				startLine: 10,
				endLine: 10,
			}),
		);

		expect(commentsForView([c], commitView("deadbeef"), FILE)).toEqual([c]);
	});

	it("excludes a comment anchored to a different commit OID", () => {
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "other-oid",
				filePath: FILE,
				side: "New",
				startLine: 10,
				endLine: 10,
			}),
		);

		expect(commentsForView([c], commitView("deadbeef"), FILE)).toEqual([]);
	});

	it("matches an unstaged comment against the working_tree_snapshot", () => {
		const view: ViewDescriptor = {
			kind: "unstaged",
			commitOid: null,
			snapshots: { working_tree_snapshot: "wt-oid", index_snapshot: "idx-oid" },
		};
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "wt-oid",
				filePath: FILE,
				side: "New",
				startLine: 3,
				endLine: 3,
			}),
		);

		expect(commentsForView([c], view, FILE)).toEqual([c]);
	});

	it("does not match an index-anchored comment in the unstaged view", () => {
		const view: ViewDescriptor = {
			kind: "unstaged",
			commitOid: null,
			snapshots: { working_tree_snapshot: "wt-oid", index_snapshot: "idx-oid" },
		};
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "idx-oid",
				filePath: FILE,
				side: "New",
				startLine: 3,
				endLine: 3,
			}),
		);

		expect(commentsForView([c], view, FILE)).toEqual([]);
	});

	it("matches a staged comment against the index_snapshot", () => {
		const view: ViewDescriptor = {
			kind: "staged",
			commitOid: null,
			snapshots: { working_tree_snapshot: "wt-oid", index_snapshot: "idx-oid" },
		};
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "idx-oid",
				filePath: FILE,
				side: "New",
				startLine: 5,
				endLine: 5,
			}),
		);

		expect(commentsForView([c], view, FILE)).toEqual([c]);
	});

	it("returns [] for a conflicted view even with an OID-bearing anchor", () => {
		const view: ViewDescriptor = {
			kind: "conflicted",
			commitOid: "deadbeef",
			snapshots: EMPTY_SNAPSHOTS,
		};
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "deadbeef",
				filePath: FILE,
				side: "New",
				startLine: 5,
				endLine: 5,
			}),
		);

		expect(commentsForView([c], view, FILE)).toEqual([]);
	});

	it("returns [] when the resolved OID is null", () => {
		const view: ViewDescriptor = {
			kind: "unstaged",
			commitOid: null,
			snapshots: EMPTY_SNAPSHOTS,
		};
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "wt-oid",
				filePath: FILE,
				side: "New",
				startLine: 3,
				endLine: 3,
			}),
		);

		expect(commentsForView([c], view, FILE)).toEqual([]);
	});

	it("excludes a comment anchored to a different file path", () => {
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "deadbeef",
				filePath: "src/other.ts",
				side: "New",
				startLine: 10,
				endLine: 10,
			}),
		);

		expect(commentsForView([c], commitView("deadbeef"), FILE)).toEqual([]);
	});

	it("excludes commit-level notes (anchor null)", () => {
		const note = commitNote("n1");

		expect(commentsForView([note], commitView("deadbeef"), FILE)).toEqual([]);
	});

	it("keeps only the matching comments out of a mixed list", () => {
		const match = lineComment(
			"match",
			anchor({
				commitOid: "deadbeef",
				filePath: FILE,
				side: "New",
				startLine: 10,
				endLine: 10,
			}),
		);
		const wrongOid = lineComment(
			"wrongOid",
			anchor({
				commitOid: "other",
				filePath: FILE,
				side: "New",
				startLine: 10,
				endLine: 10,
			}),
		);
		const wrongFile = lineComment(
			"wrongFile",
			anchor({
				commitOid: "deadbeef",
				filePath: "src/other.ts",
				side: "New",
				startLine: 10,
				endLine: 10,
			}),
		);
		const note = commitNote("note");

		expect(
			commentsForView(
				[match, wrongOid, wrongFile, note],
				commitView("deadbeef"),
				FILE,
			),
		).toEqual([match]);
	});
});

describe("commentsForLine", () => {
	const FILE = "src/main.ts";

	function newSingle(id: string, lineno: number): Thread {
		return lineComment(
			id,
			anchor({
				commitOid: "oid",
				filePath: FILE,
				side: "New",
				startLine: lineno,
				endLine: lineno,
			}),
		);
	}

	it("matches a single-line comment on its end_line", () => {
		const c = newSingle("c1", 42);

		expect(commentsForLine([c], "New", 42)).toEqual([c]);
	});

	it("hangs a multi-line comment on its end_line, not its start_line", () => {
		const c = lineComment(
			"c1",
			anchor({
				commitOid: "oid",
				filePath: FILE,
				side: "New",
				startLine: 10,
				endLine: 13,
			}),
		);

		expect(commentsForLine([c], "New", 13)).toEqual([c]);
		expect(commentsForLine([c], "New", 10)).toEqual([]);
		expect(commentsForLine([c], "New", 12)).toEqual([]);
	});

	it("does not match a New-side comment when asked for the Old side", () => {
		const c = newSingle("c1", 42);

		expect(commentsForLine([c], "Old", 42)).toEqual([]);
	});

	it("disambiguates Old line 42 from New line 42", () => {
		const oldComment = lineComment(
			"old",
			anchor({
				commitOid: "oid",
				filePath: FILE,
				side: "Old",
				startLine: 42,
				endLine: 42,
			}),
		);
		const newComment = newSingle("new", 42);

		expect(commentsForLine([oldComment, newComment], "Old", 42)).toEqual([
			oldComment,
		]);
		expect(commentsForLine([oldComment, newComment], "New", 42)).toEqual([
			newComment,
		]);
	});

	it("returns [] for a null lineno", () => {
		const c = newSingle("c1", 42);

		expect(commentsForLine([c], "New", null)).toEqual([]);
	});

	it("returns [] for an undefined lineno", () => {
		const c = newSingle("c1", 42);

		expect(commentsForLine([c], "New", undefined)).toEqual([]);
	});
});

describe("spannedByComment", () => {
	const FILE = "src/main.ts";

	function range(side: Side, startLine: number, endLine: number): Thread[] {
		return [
			lineComment(
				"c1",
				anchor({
					commitOid: "oid",
					filePath: FILE,
					side,
					startLine,
					endLine,
				}),
			),
		];
	}

	it("includes the start line of the range", () => {
		expect(spannedByComment(range("New", 10, 13), "New", 10)).toBe(true);
	});

	it("includes a middle line of the range", () => {
		expect(spannedByComment(range("New", 10, 13), "New", 11)).toBe(true);
	});

	it("includes the end line of the range", () => {
		expect(spannedByComment(range("New", 10, 13), "New", 13)).toBe(true);
	});

	it("excludes the line just before the range", () => {
		expect(spannedByComment(range("New", 10, 13), "New", 9)).toBe(false);
	});

	it("excludes the line just after the range", () => {
		expect(spannedByComment(range("New", 10, 13), "New", 14)).toBe(false);
	});

	it("does not span a line on the other side", () => {
		expect(spannedByComment(range("New", 10, 13), "Old", 11)).toBe(false);
	});

	it("returns false for a null lineno", () => {
		expect(spannedByComment(range("New", 10, 13), "New", null)).toBe(false);
	});

	it("returns false for an undefined lineno", () => {
		expect(spannedByComment(range("New", 10, 13), "New", undefined)).toBe(
			false,
		);
	});
});
