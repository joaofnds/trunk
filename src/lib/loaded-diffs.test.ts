import { describe, expect, it } from "vitest";
import {
	type LoadedDiff,
	loadedDiffFor,
	noLoadedDiffs,
	shownDiff,
	withLoadedDiff,
} from "./loaded-diffs.js";
import type { FileDiff } from "./types.js";

function listed(path: string): FileDiff {
	return {
		path,
		old_path: null,
		status: "Modified",
		is_binary: false,
		hunks: [],
	};
}

function loadedFor(path: string): LoadedDiff {
	return {
		diff: {
			...listed(path),
			hunks: [
				{
					header: "@@ -1 +1 @@",
					old_start: 1,
					old_lines: 1,
					new_start: 1,
					new_lines: 1,
					lines: [],
				},
			],
		},
		mode: "hunk",
		options: { contextLines: 3, ignoreWhitespace: false, showFullFile: false },
	};
}

describe("loadedDiffFor", () => {
	it("finds the diff loaded for a path of the same source", () => {
		const diff = loadedFor("a.ts");

		const loaded = withLoadedDiff(noLoadedDiffs<string>(), "c1", "a.ts", diff);

		expect(loadedDiffFor(loaded, "c1", "a.ts")).toBe(diff);
	});

	it("keeps the diffs of other paths loaded for the same source", () => {
		const first = loadedFor("a.ts");

		const loaded = withLoadedDiff(
			withLoadedDiff(noLoadedDiffs<string>(), "c1", "a.ts", first),
			"c1",
			"b.ts",
			loadedFor("b.ts"),
		);

		expect(loadedDiffFor(loaded, "c1", "a.ts")).toBe(first);
	});

	it("finds nothing for another source", () => {
		const loaded = withLoadedDiff(
			noLoadedDiffs<string>(),
			"c1",
			"a.ts",
			loadedFor("a.ts"),
		);

		expect(loadedDiffFor(loaded, "c2", "a.ts")).toBeUndefined();
	});

	it("forgets the previous source's diffs when one loads for another", () => {
		const loaded = withLoadedDiff(
			withLoadedDiff(noLoadedDiffs<string>(), "c1", "a.ts", loadedFor("a.ts")),
			"c2",
			"b.ts",
			loadedFor("b.ts"),
		);

		expect(loadedDiffFor(loaded, "c1", "a.ts")).toBeUndefined();
	});
});

describe("shownDiff", () => {
	it("shows the loaded diff over the list's entry for that path", () => {
		const diff = loadedFor("a.ts");
		const loaded = withLoadedDiff(noLoadedDiffs<string>(), "c1", "a.ts", diff);

		expect(shownDiff([listed("a.ts")], loaded, "c1", "a.ts")).toEqual([
			diff.diff,
		]);
	});

	it("shows the list's entry while nothing is loaded for the path", () => {
		const entry = listed("a.ts");

		expect(
			shownDiff([entry, listed("b.ts")], noLoadedDiffs(), "c1", "a.ts"),
		).toEqual([entry]);
	});
});
