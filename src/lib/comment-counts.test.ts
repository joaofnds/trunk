import { describe, expect, it } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	buildCommentCounts,
	commitOidForComment,
	fileCountKey,
	fileCountsForOid,
	fileTonesForOid,
} from "./comment-counts.js";
import type { Anchor, ReviewSnapshots, Thread } from "./types.js";

const EMPTY_SNAPSHOTS: ReviewSnapshots = {
	working_tree_snapshot: null,
	index_snapshot: null,
};

function anchor(commitOid: string, filePath: string): Anchor {
	return {
		commit_oid: commitOid,
		file_path: filePath,
		source: "Diff",
		side: "New",
		start_line: 1,
		end_line: 1,
	};
}

function lineComment(id: string, a: Anchor): Thread {
	return aThread({ id, text: `comment ${id}`, anchor: a });
}

function commitNote(id: string, commitOid: string): Thread {
	return aThread({ id, text: `note ${id}`, commit_oid: commitOid });
}

function currentFileComment(
	id: string,
	filePath: string,
	state: Thread["state"] = "open",
): Thread {
	return aThread({
		id,
		text: `pin ${id}`,
		state,
		content_pin: {
			file_path: filePath,
			block: "code",
			ordinal: 0,
			start_line: 1,
			end_line: 1,
		},
	});
}

describe("current-file projection", () => {
	it("counts a thread against the file its pin names", () => {
		const { byCurrentFile } = buildCommentCounts(
			[
				currentFileComment("a", "src/a.ts"),
				currentFileComment("b", "src/a.ts"),
				currentFileComment("c", "src/b.ts"),
			],
			EMPTY_SNAPSHOTS,
		);

		expect(byCurrentFile.get("src/a.ts")).toBe(2);
		expect(byCurrentFile.get("src/b.ts")).toBe(1);
	});

	it("leaves a commit-anchored comment out, since no file finder row is its own", () => {
		const { byCurrentFile } = buildCommentCounts(
			[lineComment("x", anchor("abc", "src/a.ts")), commitNote("y", "abc")],
			EMPTY_SNAPSHOTS,
		);

		expect(byCurrentFile.size).toBe(0);
	});
});

describe("commitOidForComment", () => {
	it("returns the anchor's commit oid for a line comment", () => {
		expect(commitOidForComment(lineComment("c1", anchor("abc", "a.ts")))).toBe(
			"abc",
		);
	});

	it("returns the top-level commit oid for a note", () => {
		expect(commitOidForComment(commitNote("n1", "def"))).toBe("def");
	});

	it("returns empty string for a note with no commit oid", () => {
		const note = aThread({ id: "n2", text: "orphan note" });
		expect(commitOidForComment(note)).toBe("");
	});
});

describe("buildCommentCounts", () => {
	it("returns empty maps for empty input", () => {
		const { byCommit, byFile } = buildCommentCounts([], EMPTY_SNAPSHOTS);
		expect(byCommit.size).toBe(0);
		expect(byFile.size).toBe(0);
	});

	it("counts a line comment under both byCommit and byFile", () => {
		const { byCommit, byFile } = buildCommentCounts(
			[lineComment("c1", anchor("abc", "a.ts"))],
			EMPTY_SNAPSHOTS,
		);
		expect(byCommit.get("abc")).toBe(1);
		expect(byFile.get(fileCountKey("abc", "a.ts"))).toBe(1);
	});

	it("counts a note under byCommit only, never byFile", () => {
		const { byCommit, byFile } = buildCommentCounts(
			[commitNote("n1", "abc")],
			EMPTY_SNAPSHOTS,
		);
		expect(byCommit.get("abc")).toBe(1);
		expect(byFile.size).toBe(0);
	});

	it("aggregates multiple comments on the same commit and file", () => {
		const { byCommit, byFile } = buildCommentCounts(
			[
				lineComment("c1", anchor("abc", "a.ts")),
				lineComment("c2", anchor("abc", "a.ts")),
				commitNote("n1", "abc"),
			],
			EMPTY_SNAPSHOTS,
		);
		expect(byCommit.get("abc")).toBe(3);
		expect(byFile.get(fileCountKey("abc", "a.ts"))).toBe(2);
	});

	it("counts only unresolved threads in the default population", () => {
		const { byCommit } = buildCommentCounts(
			[
				lineComment("open", anchor("abc", "a.ts")),
				aThread({
					id: "done",
					text: "comment done",
					state: "done",
					anchor: anchor("abc", "a.ts"),
				}),
			],
			EMPTY_SNAPSHOTS,
		);

		expect(byCommit.get("abc")).toBe(1);
	});

	it("leaves resolved current-file threads out of the default finder badges", () => {
		const { byCurrentFile } = buildCommentCounts(
			[currentFileComment("done", "a.ts", "done")],
			EMPTY_SNAPSHOTS,
		);

		expect(byCurrentFile.has("a.ts")).toBe(false);
	});

	it("projects an explicit state filter and carries its tone to commit/file buckets", () => {
		const { byCommit, byFile, toneByCommit, toneByFile } = buildCommentCounts(
			[
				lineComment("open", anchor("abc", "a.ts")),
				aThread({
					id: "done",
					text: "done",
					state: "done",
					anchor: anchor("abc", "a.ts"),
				}),
			],
			EMPTY_SNAPSHOTS,
			"done",
		);

		expect(byCommit.get("abc")).toBe(1);
		expect(byFile.get(fileCountKey("abc", "a.ts"))).toBe(1);
		expect(toneByCommit.get("abc")).toBe("done");
		expect(toneByFile.get(fileCountKey("abc", "a.ts"))).toBe("done");
		expect(fileTonesForOid(toneByFile, "abc").get("a.ts")).toBe("done");
	});

	it("folds working-tree and index snapshot comments into the __wip__ bucket", () => {
		const snapshots: ReviewSnapshots = {
			working_tree_snapshot: "wt",
			index_snapshot: "idx",
		};
		const { byCommit } = buildCommentCounts(
			[
				lineComment("c1", anchor("wt", "a.ts")),
				lineComment("c2", anchor("idx", "b.ts")),
				lineComment("c3", anchor("abc", "c.ts")),
			],
			snapshots,
		);
		expect(byCommit.get("__wip__")).toBe(2);
		expect(byCommit.get("wt")).toBe(1);
		expect(byCommit.get("idx")).toBe(1);
		expect(byCommit.get("abc")).toBe(1);
	});

	it("does not create a __wip__ bucket when no snapshot comments exist", () => {
		const snapshots: ReviewSnapshots = {
			working_tree_snapshot: "wt",
			index_snapshot: "idx",
		};
		const { byCommit } = buildCommentCounts(
			[lineComment("c1", anchor("abc", "a.ts"))],
			snapshots,
		);
		expect(byCommit.has("__wip__")).toBe(false);
	});
});

describe("fileCountsForOid", () => {
	it("returns an empty map for a null oid", () => {
		const { byFile } = buildCommentCounts(
			[lineComment("c1", anchor("abc", "a.ts"))],
			EMPTY_SNAPSHOTS,
		);
		expect(fileCountsForOid(byFile, null).size).toBe(0);
	});

	it("slices byFile down to a path → count map for one oid", () => {
		const { byFile } = buildCommentCounts(
			[
				lineComment("c1", anchor("abc", "a.ts")),
				lineComment("c2", anchor("abc", "dir/b.ts")),
				lineComment("c3", anchor("xyz", "a.ts")),
			],
			EMPTY_SNAPSHOTS,
		);
		const sliced = fileCountsForOid(byFile, "abc");
		expect(sliced.get("a.ts")).toBe(1);
		expect(sliced.get("dir/b.ts")).toBe(1);
		expect(sliced.has("xyz")).toBe(false);
		expect(sliced.size).toBe(2);
	});
});
