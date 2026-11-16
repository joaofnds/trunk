import { describe, expect, it } from "vitest";
import type { ConflictRegion } from "./merge-parser.js";
import {
	computeOutput,
	getConflictIndices,
	parseConflictRegions,
	takeAllCurrent,
	takeAllIncoming,
	toggleHunk,
	toggleLine,
} from "./merge-parser.js";

describe("parseConflictRegions", () => {
	it("identifies context and conflict regions from a simple three-way diff", () => {
		const base = "A\nB\nC";
		const ours = "A\nX\nC";
		const theirs = "A\nY\nC";

		const regions = parseConflictRegions(base, ours, theirs);

		expect(regions).toHaveLength(3);

		// Region 0: context "A"
		expect(regions[0].type).toBe("context");
		expect(regions[0].baseLines).toEqual(["A"]);
		expect(regions[0].oursLines).toEqual(["A"]);
		expect(regions[0].theirsLines).toEqual(["A"]);

		// Region 1: conflict (ours: X, theirs: Y)
		expect(regions[1].type).toBe("conflict");
		expect(regions[1].oursLines).toEqual(["X"]);
		expect(regions[1].theirsLines).toEqual(["Y"]);

		// Region 2: context "C"
		expect(regions[2].type).toBe("context");
		expect(regions[2].baseLines).toEqual(["C"]);
	});

	it("treats the entire file as a conflict when base is empty and sides differ", () => {
		const base = "";
		const ours = "line1\nline2";
		const theirs = "lineA\nlineB";

		const regions = parseConflictRegions(base, ours, theirs);

		expect(regions).toHaveLength(1);
		expect(regions[0].type).toBe("conflict");
		expect(regions[0].oursLines).toEqual(["line1", "line2"]);
		expect(regions[0].theirsLines).toEqual(["lineA", "lineB"]);
	});

	it("returns a single context region when all three sides are identical", () => {
		const base = "A\nB";
		const ours = "A\nB";
		const theirs = "A\nB";

		const regions = parseConflictRegions(base, ours, theirs);

		expect(regions).toHaveLength(1);
		expect(regions[0].type).toBe("context");
		expect(regions[0].baseLines).toEqual(["A", "B"]);
		expect(regions[0].oursLines).toEqual(["A", "B"]);
		expect(regions[0].theirsLines).toEqual(["A", "B"]);
	});

	it("returns empty array when all three inputs are empty strings", () => {
		const regions = parseConflictRegions("", "", "");
		expect(regions).toEqual([]);
	});

	it("returns context for empty base when ours and theirs are identical", () => {
		const regions = parseConflictRegions("", "A\nB", "A\nB");
		expect(regions).toHaveLength(1);
		expect(regions[0].type).toBe("context");
		expect(regions[0].oursLines).toEqual(["A", "B"]);
	});

	it.each([
		["the incoming side alone", "A\nB\nC", "A\nY\nC"],
		["the current side alone", "A\nX\nC", "A\nB\nC"],
		["both sides identically", "A\nX\nC", "A\nX\nC"],
	])(
		"counts a change made by %s as resolved rather than as a conflict",
		(_, ours, theirs) => {
			const regions = parseConflictRegions("A\nB\nC", ours, theirs);

			expect(regions.map((r) => r.type)).toEqual([
				"context",
				"resolved",
				"context",
			]);
			expect(getConflictIndices(regions)).toEqual([]);
		},
	);

	it("handles input with only whitespace lines", () => {
		const regions = parseConflictRegions(" ", " ", " ");
		expect(regions).toHaveLength(1);
		expect(regions[0].type).toBe("context");
		expect(regions[0].baseLines).toEqual([" "]);
	});
});

describe("computeOutput", () => {
	// Helper: create regions with one conflict in the middle
	function makeRegions(): ConflictRegion[] {
		return [
			{
				type: "context",
				baseLines: ["A"],
				oursLines: ["A"],
				theirsLines: ["A"],
			},
			{
				type: "conflict",
				baseLines: ["B"],
				oursLines: ["X"],
				theirsLines: ["Y"],
			},
			{
				type: "context",
				baseLines: ["C"],
				oursLines: ["C"],
				theirsLines: ["C"],
			},
		];
	}

	it("outputs only context lines when no conflict lines are taken", () => {
		const regions = makeRegions();
		const takenLines = new Set<string>();

		const output = computeOutput(regions, takenLines);
		expect(output).toBe("A\nC");
	});

	it("includes ours lines when they are taken", () => {
		const regions = makeRegions();
		const takenLines = new Set<string>(["ours-1-0"]);

		const output = computeOutput(regions, takenLines);
		expect(output).toBe("A\nX\nC");
	});

	it("keeps the incoming side's own change when every conflict takes the current side", () => {
		const regions = parseConflictRegions(
			"a\nb\nc\nd\ne",
			"a\nb\nc\nd\nE-ours",
			"a\nB-theirs\nc\nd\nE-theirs",
		);

		const output = computeOutput(regions, takeAllCurrent(regions));

		expect(output).toBe("a\nB-theirs\nc\nd\nE-ours");
	});

	it("keeps the current side's own change when every conflict takes the incoming side", () => {
		const regions = parseConflictRegions(
			"a\nb\nc\nd\ne",
			"a\nB-ours\nc\nd\nE-ours",
			"a\nb\nc\nd\nE-theirs",
		);

		const output = computeOutput(regions, takeAllIncoming(regions));

		expect(output).toBe("a\nB-ours\nc\nd\nE-theirs");
	});

	it("keeps a deletion only one side made", () => {
		const regions = parseConflictRegions("a\nb\nc", "a\nb\nc", "a\nc");

		const output = computeOutput(regions, takeAllCurrent(regions));

		expect(output).toBe("a\nc");
	});

	it("includes both ours and theirs lines with ours first", () => {
		const regions = makeRegions();
		const takenLines = new Set<string>(["ours-1-0", "theirs-1-0"]);

		const output = computeOutput(regions, takenLines);
		expect(output).toBe("A\nX\nY\nC");
	});
});

describe("takeAllCurrent", () => {
	it("returns a Set containing all ours line keys from all conflict regions", () => {
		const regions: ConflictRegion[] = [
			{
				type: "context",
				baseLines: ["A"],
				oursLines: ["A"],
				theirsLines: ["A"],
			},
			{
				type: "conflict",
				baseLines: ["B"],
				oursLines: ["X1", "X2"],
				theirsLines: ["Y1"],
			},
			{
				type: "context",
				baseLines: ["C"],
				oursLines: ["C"],
				theirsLines: ["C"],
			},
			{
				type: "conflict",
				baseLines: ["D"],
				oursLines: ["Z1"],
				theirsLines: ["W1"],
			},
		];

		const result = takeAllCurrent(regions);

		expect(result).toEqual(new Set(["ours-1-0", "ours-1-1", "ours-3-0"]));
	});
});

describe("takeAllIncoming", () => {
	it("returns a Set containing all theirs line keys from all conflict regions", () => {
		const regions: ConflictRegion[] = [
			{
				type: "context",
				baseLines: ["A"],
				oursLines: ["A"],
				theirsLines: ["A"],
			},
			{
				type: "conflict",
				baseLines: ["B"],
				oursLines: ["X1"],
				theirsLines: ["Y1", "Y2"],
			},
			{
				type: "context",
				baseLines: ["C"],
				oursLines: ["C"],
				theirsLines: ["C"],
			},
			{
				type: "conflict",
				baseLines: ["D"],
				oursLines: ["Z1"],
				theirsLines: ["W1"],
			},
		];

		const result = takeAllIncoming(regions);

		expect(result).toEqual(new Set(["theirs-1-0", "theirs-1-1", "theirs-3-0"]));
	});
});

describe("toggleHunk", () => {
	it("adds all ours lines from region 0 when starting from empty, and removes them on second call", () => {
		const regions: ConflictRegion[] = [
			{
				type: "conflict",
				baseLines: ["B"],
				oursLines: ["X1", "X2"],
				theirsLines: ["Y1"],
			},
			{
				type: "context",
				baseLines: ["C"],
				oursLines: ["C"],
				theirsLines: ["C"],
			},
		];
		const empty = new Set<string>();

		// First toggle: adds all ours lines in region 0
		const afterAdd = toggleHunk("ours", 0, regions, empty);
		expect(afterAdd).toEqual(new Set(["ours-0-0", "ours-0-1"]));

		// Second toggle: removes them (all were present)
		const afterRemove = toggleHunk("ours", 0, regions, afterAdd);
		expect(afterRemove).toEqual(new Set());
	});
});

describe("toggleLine", () => {
	it("adds a key when absent and removes it when present", () => {
		const initial = new Set<string>();

		// Add
		const afterAdd = toggleLine("ours-1-2", initial);
		expect(afterAdd.has("ours-1-2")).toBe(true);

		// Remove
		const afterRemove = toggleLine("ours-1-2", afterAdd);
		expect(afterRemove.has("ours-1-2")).toBe(false);
	});
});

describe("getConflictIndices", () => {
	it("returns indices of conflict regions only", () => {
		const regions: ConflictRegion[] = [
			{
				type: "context",
				baseLines: ["A"],
				oursLines: ["A"],
				theirsLines: ["A"],
			},
			{
				type: "conflict",
				baseLines: ["B"],
				oursLines: ["X"],
				theirsLines: ["Y"],
			},
			{
				type: "context",
				baseLines: ["C"],
				oursLines: ["C"],
				theirsLines: ["C"],
			},
			{
				type: "conflict",
				baseLines: ["D"],
				oursLines: ["Z"],
				theirsLines: ["W"],
			},
			{
				type: "context",
				baseLines: ["E"],
				oursLines: ["E"],
				theirsLines: ["E"],
			},
		];

		expect(getConflictIndices(regions)).toEqual([1, 3]);
	});
});
