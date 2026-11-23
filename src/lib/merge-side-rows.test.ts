import { describe, expect, it } from "vitest";
import {
	conflictRegion,
	gitMergedRegion,
	mergedRegion,
} from "../__tests__/helpers/factories.js";
import { mapOffset } from "./merge-scroll.js";
import {
	buildMergeSideRows,
	mergeScrollLayouts,
	reflowedSideTop,
} from "./merge-side-rows.js";

describe(buildMergeSideRows, () => {
	it("preserves each side's numbered conflict context while expanding a single gap", () => {
		const regions = [
			gitMergedRegion({
				ours: ["a", "b", "c", "d"],
				theirs: ["x", "y"],
				merged: ["a", "b", "c", "d"],
			}),
			conflictRegion(["ours"], ["theirs"]),
			mergedRegion("next", "hidden", "last"),
			conflictRegion(["again"], []),
		];

		const folded = buildMergeSideRows(regions, 1, new Set(), 0);
		const expanded = buildMergeSideRows(regions, 1, new Set([2]), 0);
		const full = buildMergeSideRows(regions, null, new Set(), 0);

		expect(folded.rows[0]).toMatchObject({ type: "gap", hidden: 3 });
		expect(folded.rows[1]).toMatchObject({
			ours: { text: "d", lineNum: 4 },
			theirs: { text: "y", lineNum: 2 },
		});
		expect(folded.rows[3]).toMatchObject({
			ours: { key: "ours-1-0", lineNum: 5 },
			theirs: { key: "theirs-1-0", lineNum: 3 },
		});
		expect(
			expanded.rows
				.filter((row) => row.type === "gap")
				.map((row) => row.regionIdx),
		).toEqual([0]);
		expect(expanded.rows.some((row) => row.ours?.text === "hidden")).toBe(true);
		expect(full.rows.filter((row) => row.type === "gap")).toEqual([]);
		expect(full.rows[0].ours?.text).toBe("a");
	});
	it.each([
		[`${"a".repeat(34)}\t${"a".repeat(34)}`, 35, 3],
		[`${"a".repeat(30)}漢${"b".repeat(30)}`, 31, 3],
		["\t".repeat(5), 5, 5],
	] as const)(
		"moves a character across a soft break when it cannot fit (%s at %i columns)",
		(line, width, rows) => {
			const model = buildMergeSideRows(
				[mergedRegion(line)],
				null,
				new Set(),
				width,
			);
			expect(model.rows[0].height).toBe(rows * 18);
		},
	);

	it("uses a visible source line's measured height for the paired row and the following region", () => {
		const regions = [mergedRegion("👩‍💻"), conflictRegion(["next"], ["other"])];
		const model = buildMergeSideRows(
			regions,
			null,
			new Set(),
			4,
			new Map([["theirs-0-0", 54]]),
		);

		expect(model.offsets[1]).toBe(54);
		expect(model.regionTops[1]).toBe(54);
	});

	it("gives both sides the height of the taller wrapped line including its tab stop", () => {
		const regions = [
			conflictRegion(["a", "short"], ["a\t12345"]),
			mergedRegion("after"),
		];

		const wrapped = buildMergeSideRows(regions, null, new Set(), 4);
		const unwrapped = buildMergeSideRows(regions, null, new Set(), 0);

		expect(wrapped.rows[1].height).toBe(54);
		expect(wrapped.regionTops[1] - unwrapped.regionTops[1]).toBe(54);
		expect(wrapped.rows[2].theirs).toBeUndefined();
	});
});

describe(reflowedSideTop, () => {
	it("keeps the line in the pane being read when an uneven gap expands", () => {
		const regions = [
			gitMergedRegion({
				ours: ["a", "b", "c", "d"],
				theirs: ["1", "2", "3", "4", "5", "6", "7", "8"],
				merged: [],
			}),
			conflictRegion(["x"], ["y"]),
		];
		const before = buildMergeSideRows(regions, 2, new Set(), 0);
		const after = buildMergeSideRows(regions, null, new Set(), 0);
		const view = { before, after, top: before.offsets[1], viewport: 18 };
		expect(reflowedSideTop({ ...view, readingSide: "ours" })).toBe(
			after.offsets[2],
		);
		expect(reflowedSideTop({ ...view, readingSide: "theirs" })).toBe(
			after.offsets[6],
		);
	});

	it("keeps the visible conflict in place across folding and the same source row across wrapping", () => {
		const regions = [
			mergedRegion(...Array(20).fill("abcdefgh")),
			conflictRegion(["ours"], ["theirs"]),
		];
		const full = buildMergeSideRows(regions, null, new Set(), 0);
		const folded = buildMergeSideRows(regions, 2, new Set(), 0);
		const wrapped = buildMergeSideRows(regions, null, new Set(), 4);

		expect(
			reflowedSideTop({
				before: full,
				after: folded,
				top: 350,
				viewport: 100,
				focusedRegion: 1,
			}),
		).toBe(folded.regionTops[1] - 10);
		expect(
			reflowedSideTop({ before: full, after: wrapped, top: 93, viewport: 100 }),
		).toBe(183);
	});
});

describe(mergeScrollLayouts, () => {
	it("keeps logical output lines aligned when the side wraps into more rows", () => {
		const lines = [
			"x".repeat(240),
			...Array.from({ length: 60 }, (_, i) => String(i)),
		];
		const model = buildMergeSideRows(
			[mergedRegion(...lines)],
			null,
			new Set(),
			20,
		);

		const { side, output } = mergeScrollLayouts(model, [lines], 60);

		expect(mapOffset(side, output, model.offsets[1])).toBe(72);
		expect(mapOffset(output, side, 72)).toBe(216);
	});

	it("maps an automatic merge to the lines retained from each side", () => {
		const lines = [
			"long ours",
			"from incoming",
			"extra in output",
			"last ours",
		];
		const regions = [
			gitMergedRegion({
				ours: ["long ours", "was removed", "another deletion", "last ours"],
				theirs: ["old incoming", "from incoming"],
				merged: lines,
			}),
		];
		const model = buildMergeSideRows(regions, null, new Set(), 5);

		const { side, output } = mergeScrollLayouts(model, [lines], 50);

		expect(mapOffset(side, output, model.offsets[1])).toBe(18);
		expect(mapOffset(side, output, model.offsets[3])).toBe(54);
	});

	it("maps the first visible line after a folded gap to its complete output position", () => {
		const context = ["hidden first", "hidden second", "visible", "before"];
		const regions = [
			mergedRegion(...context),
			conflictRegion(["new"], ["other"]),
		];
		const model = buildMergeSideRows(regions, 2, new Set(), 0);

		const { side, output } = mergeScrollLayouts(model, [context, ["new"]], 4);

		expect(mapOffset(side, output, model.offsets[1])).toBe(7 * 18);
		expect(mapOffset(output, side, 7 * 18)).toBe(model.offsets[1]);
	});
});
