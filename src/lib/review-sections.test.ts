import { describe, expect, it } from "vitest";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { reviewSections } from "./review-sections.js";
import type { RefLabel, Thread } from "./types.js";

function branch(name: string, colorIndex: number, isHead = false): RefLabel {
	return {
		name: `refs/heads/${name}`,
		short_name: name,
		ref_type: "LocalBranch",
		is_head: isHead,
		color_index: colorIndex,
	};
}

function onLine(id: string, oid: string, path: string, line: number): Thread {
	return aThread({
		id,
		anchor: {
			commit_oid: oid,
			file_path: path,
			source: "Diff",
			side: "New",
			start_line: line,
			end_line: line,
		},
	});
}

function onCommit(id: string, oid: string): Thread {
	return aThread({ id, commit_oid: oid });
}

function onCurrentFile(id: string, path: string, line: number): Thread {
	return aThread({
		id,
		content_pin: {
			file_path: path,
			block: "",
			ordinal: 0,
			start_line: line,
			end_line: line,
		},
	});
}

const main = branch("main", 0, true);
const feature = branch("feature", 3);

describe("reviewSections", () => {
	it("gathers commits into one section per branch, in graph order", () => {
		const commits = [
			aSessionCommit({ oid: "f1", lane_ref: feature }),
			aSessionCommit({ oid: "m1", lane_ref: main }),
			aSessionCommit({ oid: "f2", lane_ref: feature }),
		];

		const sections = reviewSections({
			threads: [],
			commits,
			headBranch: "main",
		});

		expect(
			sections.map((s) => [s.branch, s.groups.map((g) => g.commit?.oid)]),
		).toEqual([
			["feature", ["f1", "f2"]],
			["main", ["m1"]],
		]);
	});

	it("colours a section by its branch's lane and marks the checked-out one", () => {
		const commits = [
			aSessionCommit({ oid: "f1", lane_ref: feature }),
			aSessionCommit({ oid: "m1", lane_ref: main }),
		];

		const sections = reviewSections({
			threads: [],
			commits,
			headBranch: "main",
		});

		expect(sections.map((s) => [s.colorIndex, s.isHead])).toEqual([
			[3, false],
			[0, true],
		]);
	});

	it("puts commits the graph does not draw last, on no branch", () => {
		const commits = [
			aSessionCommit({ oid: "x1" }),
			aSessionCommit({ oid: "m1", lane_ref: main }),
		];

		const sections = reviewSections({
			threads: [],
			commits,
			headBranch: "main",
		});

		expect(sections.map((s) => s.branch)).toEqual(["main", null]);
	});

	it("puts uncommitted work and current-file threads under the checked-out branch", () => {
		const commits = [
			aSessionCommit({ oid: "m1", lane_ref: main }),
			aSessionCommit({ oid: "wt", is_snapshot: true }),
		];
		const threads = [
			onLine("t1", "wt", "a.ts", 1),
			onCurrentFile("t2", "b.ts", 4),
		];

		const sections = reviewSections({ threads, commits, headBranch: "main" });

		expect(
			sections.map((s) => [s.branch, s.groups.map((g) => g.kind)]),
		).toEqual([["main", ["commit", "uncommitted", "current"]]]);
	});

	it("opens a section for the checked-out branch when no reviewed commit is on it", () => {
		const threads = [onCurrentFile("t1", "b.ts", 4)];

		const sections = reviewSections({
			threads,
			commits: [],
			headBranch: "main",
		});

		expect(sections.map((s) => [s.branch, s.isHead, s.colorIndex])).toEqual([
			["main", true, null],
		]);
	});

	it("drops an uncommitted snapshot nobody commented on but keeps a picked commit", () => {
		const commits = [
			aSessionCommit({ oid: "m1", lane_ref: main }),
			aSessionCommit({ oid: "wt", is_snapshot: true }),
		];

		const sections = reviewSections({
			threads: [],
			commits,
			headBranch: "main",
		});

		expect(sections.flatMap((s) => s.groups.map((g) => g.commit?.oid))).toEqual(
			["m1"],
		);
	});

	it("orders a commit's threads as whole-commit notes, then one block per file by line", () => {
		const commits = [aSessionCommit({ oid: "m1", lane_ref: main })];
		const threads = [
			onLine("late", "m1", "a.ts", 30),
			onLine("other", "m1", "b.ts", 1),
			onCommit("note", "m1"),
			onLine("early", "m1", "a.ts", 2),
		];

		const [group] = reviewSections({ threads, commits, headBranch: "main" })[0]
			.groups;

		expect({
			notes: group.notes.map((t) => t.id),
			files: group.files.map((f) => [f.path, f.threads.map((t) => t.id)]),
			threads: group.threads.map((t) => t.id),
		}).toEqual({
			notes: ["note"],
			files: [
				["a.ts", ["early", "late"]],
				["b.ts", ["other"]],
			],
			threads: ["note", "early", "late", "other"],
		});
	});

	it("names a commit the repository has lost as gone", () => {
		const commits = [aSessionCommit({ oid: "x1", exists: false })];

		const sections = reviewSections({
			threads: [],
			commits,
			headBranch: "main",
		});

		expect(sections[0].groups[0].kind).toBe("gone");
	});

	it("gives a thread on a commit outside the review its own group on no branch", () => {
		const threads = [onLine("t1", "zzzzzzzzz", "a.ts", 1)];

		const sections = reviewSections({
			threads,
			commits: [],
			headBranch: "main",
		});

		expect(
			sections.map((s) => [
				s.branch,
				s.groups.map((g) => [g.kind, g.commit?.short_oid]),
			]),
		).toEqual([[null, [["commit", "zzzzzzz"]]]]);
	});

	describe("when HEAD is detached", () => {
		it("puts current-file threads on no branch", () => {
			const threads = [onCurrentFile("t1", "b.ts", 4)];

			const sections = reviewSections({
				threads,
				commits: [],
				headBranch: null,
			});

			expect(sections.map((s) => s.branch)).toEqual([null]);
		});
	});
});
