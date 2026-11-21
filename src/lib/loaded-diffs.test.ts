import { describe, expect, it } from "vitest";
import {
	type LoadedDiff,
	loadedDiffFor,
	loadedModeFor,
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
		old_size: null,
		new_size: null,
		hunks: [],
	};
}

function loadedFor(path: string, showFullFile = false): LoadedDiff {
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
		options: { contextLines: 3, ignoreWhitespace: false, showFullFile },
	};
}

describe("loadedDiffFor", () => {
	it("finds the diff loaded at the same source and path", () => {
		const diff = loadedFor("a.ts");

		const loaded = withLoadedDiff(
			noLoadedDiffs<string>(),
			{ source: "c1", path: "a.ts" },
			diff,
		);

		expect(loadedDiffFor(loaded, { source: "c1", path: "a.ts" })).toBe(diff);
	});

	it("finds nothing for another source", () => {
		const loaded = withLoadedDiff(
			noLoadedDiffs<string>(),
			{ source: "c1", path: "a.ts" },
			loadedFor("a.ts"),
		);

		expect(
			loadedDiffFor(loaded, { source: "c2", path: "a.ts" }),
		).toBeUndefined();
	});
});

describe("withLoadedDiff", () => {
	it("keeps the diffs of other paths loaded for the same source", () => {
		const first = loadedFor("a.ts");

		const loaded = withLoadedDiff(
			withLoadedDiff(
				noLoadedDiffs<string>(),
				{ source: "c1", path: "a.ts" },
				first,
			),
			{ source: "c1", path: "b.ts" },
			loadedFor("b.ts"),
		);

		expect(loadedDiffFor(loaded, { source: "c1", path: "a.ts" })).toBe(first);
	});

	it("forgets the previous source's diffs when one loads for another", () => {
		const loaded = withLoadedDiff(
			withLoadedDiff(
				noLoadedDiffs<string>(),
				{ source: "c1", path: "a.ts" },
				loadedFor("a.ts"),
			),
			{ source: "c2", path: "b.ts" },
			loadedFor("b.ts"),
		);

		expect(
			loadedDiffFor(loaded, { source: "c1", path: "a.ts" }),
		).toBeUndefined();
	});
});

describe("loadedModeFor", () => {
	it("names the mode the loaded diff was read in", () => {
		const loaded = withLoadedDiff(
			noLoadedDiffs<string>(),
			{ source: "c1", path: "a.ts" },
			loadedFor("a.ts", true),
		);

		expect(loadedModeFor(loaded, { source: "c1", path: "a.ts" })).toBe("full");
	});

	it("is null while nothing is loaded at the slot", () => {
		expect(
			loadedModeFor(noLoadedDiffs<string>(), { source: "c1", path: "a.ts" }),
		).toBeNull();
	});
});

describe("shownDiff", () => {
	it("shows the loaded diff over the list's entry for that path", () => {
		const diff = loadedFor("a.ts");
		const loaded = withLoadedDiff(
			noLoadedDiffs<string>(),
			{ source: "c1", path: "a.ts" },
			diff,
		);

		expect(
			shownDiff([listed("a.ts")], loaded, { source: "c1", path: "a.ts" }),
		).toEqual([diff.diff]);
	});

	it("shows the list's entry while nothing is loaded for the path", () => {
		const entry = listed("a.ts");

		expect(
			shownDiff([entry, listed("b.ts")], noLoadedDiffs(), {
				source: "c1",
				path: "a.ts",
			}),
		).toEqual([entry]);
	});

	it("shows the list's entry rather than a diff loaded for another source", () => {
		const entry = listed("a.ts");
		const loaded = withLoadedDiff(
			noLoadedDiffs<string>(),
			{ source: "c1", path: "a.ts" },
			loadedFor("a.ts"),
		);

		expect(shownDiff([entry], loaded, { source: "c2", path: "a.ts" })).toEqual([
			entry,
		]);
	});
});
