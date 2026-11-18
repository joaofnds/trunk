import { describe, expect, it } from "vitest";
import {
	conflictRegion as conflict,
	gitMergedRegion,
	mergedRegion as merged,
} from "../__tests__/helpers/factories.js";
import {
	computeOutput,
	getConflictIndices,
	outputRegions,
	takeAllCurrent,
	takeAllIncoming,
	toggleHunk,
	toggleLine,
} from "./merge-parser.js";

describe("computeOutput", () => {
	const oneConflict = [merged("A"), conflict(["X"], ["Y"]), merged("C")];

	it("outputs only the merged lines when no conflict lines are taken", () => {
		expect(computeOutput(oneConflict, new Set())).toBe("A\nC");
	});

	it("includes ours lines when they are taken", () => {
		expect(computeOutput(oneConflict, new Set(["ours-1-0"]))).toBe("A\nX\nC");
	});

	it("includes both ours and theirs lines with ours first", () => {
		const taken = new Set(["ours-1-0", "theirs-1-0"]);

		expect(computeOutput(oneConflict, taken)).toBe("A\nX\nY\nC");
	});

	it("writes the text git merged where only the incoming side changed it", () => {
		const regions = [
			gitMergedRegion({
				ours: ["a", "b"],
				theirs: ["a", "B-theirs"],
				merged: ["a", "B-theirs"],
			}),
			conflict(["E-ours"], ["E-theirs"]),
		];

		const output = computeOutput(regions, takeAllCurrent(regions));

		expect(output).toBe("a\nB-theirs\nE-ours");
	});

	it("writes nothing where git merged a deletion only one side made", () => {
		const regions = [
			merged("a"),
			gitMergedRegion({ ours: ["b"], theirs: [], merged: [] }),
			merged("c"),
		];

		expect(computeOutput(regions, new Set())).toBe("a\nc");
	});
});

describe("outputRegions", () => {
	it("keeps each region's output lines apart, with none for a conflict nothing was taken from", () => {
		const regions = [merged("A"), conflict(["X"], ["Y"]), merged("C")];

		expect(outputRegions(regions, new Set())).toEqual([["A"], [], ["C"]]);
	});
});

describe("takeAllCurrent", () => {
	it("returns a Set containing all ours line keys from all conflict regions", () => {
		const regions = [
			merged("A"),
			conflict(["X1", "X2"], ["Y1"]),
			merged("C"),
			conflict(["Z1"], ["W1"]),
		];

		const result = takeAllCurrent(regions);

		expect(result).toEqual(new Set(["ours-1-0", "ours-1-1", "ours-3-0"]));
	});
});

describe("takeAllIncoming", () => {
	it("returns a Set containing all theirs line keys from all conflict regions", () => {
		const regions = [
			merged("A"),
			conflict(["X1"], ["Y1", "Y2"]),
			merged("C"),
			conflict(["Z1"], ["W1"]),
		];

		const result = takeAllIncoming(regions);

		expect(result).toEqual(new Set(["theirs-1-0", "theirs-1-1", "theirs-3-0"]));
	});
});

describe("toggleHunk", () => {
	it("adds all ours lines from region 0 when starting from empty, and removes them on second call", () => {
		const regions = [conflict(["X1", "X2"], ["Y1"]), merged("C")];

		const afterAdd = toggleHunk("ours", 0, regions, new Set());
		const afterRemove = toggleHunk("ours", 0, regions, afterAdd);

		expect(afterAdd).toEqual(new Set(["ours-0-0", "ours-0-1"]));
		expect(afterRemove).toEqual(new Set());
	});
});

describe("toggleLine", () => {
	it("adds a key when absent and removes it when present", () => {
		const afterAdd = toggleLine("ours-1-2", new Set());
		const afterRemove = toggleLine("ours-1-2", afterAdd);

		expect(afterAdd.has("ours-1-2")).toBe(true);
		expect(afterRemove.has("ours-1-2")).toBe(false);
	});
});

describe("getConflictIndices", () => {
	it("returns indices of conflict regions only", () => {
		const regions = [
			merged("A"),
			conflict(["X"], ["Y"]),
			merged("C"),
			conflict(["Z"], ["W"]),
			merged("E"),
		];

		expect(getConflictIndices(regions)).toEqual([1, 3]);
	});
});
