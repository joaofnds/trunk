import { describe, expect, it } from "vitest";
import { getVisibleOverlayElements } from "./overlay-visible.js";
import type {
	OverlayNode,
	OverlayPath,
	OverlayRefPill,
	RefLabel,
} from "./types.js";

/** Factory: minimal OverlayPath with minRow/maxRow */
function makePath(overrides: {
	minRow: number;
	maxRow: number;
	colorIndex?: number;
	dashed?: boolean;
}): OverlayPath {
	return {
		d: "M 0 0 V 100",
		colorIndex: overrides.colorIndex ?? 0,
		dashed: overrides.dashed ?? false,
		minRow: overrides.minRow,
		maxRow: overrides.maxRow,
	};
}

/** Factory: minimal OverlayNode */
function makeNode(overrides: {
	oid?: string;
	x?: number;
	y: number;
}): OverlayNode {
	return {
		oid: overrides.oid ?? "abc",
		x: overrides.x ?? 0,
		y: overrides.y,
		colorIndex: 0,
		isMerge: false,
		isBranchTip: false,
		isStash: false,
		isWip: false,
	};
}

describe("getVisibleOverlayElements", () => {
	describe("empty input", () => {
		it("returns empty paths, dots, pills for empty input", () => {
			const result = getVisibleOverlayElements([], [], 0, 10);
			expect(result).toEqual({ paths: [], dots: [], pills: [] });
		});

		it("returns empty dots when only nodes are empty", () => {
			const path = makePath({ minRow: 5, maxRow: 10 });
			const result = getVisibleOverlayElements([path], [], 5, 10);
			expect(result.dots).toEqual([]);
		});

		it("returns empty paths when only paths are empty", () => {
			const node = makeNode({ y: 5 });
			const result = getVisibleOverlayElements([], [node], 5, 10);
			expect(result.paths).toEqual([]);
		});
	});

	describe("path visibility (range intersection)", () => {
		it("path spanning rows 0-10 is included when visible range is [3, 8]", () => {
			const path = makePath({ minRow: 0, maxRow: 10 });
			const result = getVisibleOverlayElements([path], [], 3, 8);
			expect(result.paths).toHaveLength(1);
		});

		it("path spanning rows 0-10 is excluded when visible range is [15, 20]", () => {
			const path = makePath({ minRow: 0, maxRow: 10 });
			const result = getVisibleOverlayElements([path], [], 15, 20);
			expect(result.paths).toHaveLength(0);
		});

		it("path spanning rows 0-100 is included when visible range is [30, 60]", () => {
			const path = makePath({ minRow: 0, maxRow: 100 });
			const result = getVisibleOverlayElements([path], [], 30, 60);
			expect(result.paths).toHaveLength(1);
		});

		it("path entirely before visible range is excluded", () => {
			const path = makePath({ minRow: 0, maxRow: 5 });
			const result = getVisibleOverlayElements([path], [], 10, 20);
			expect(result.paths).toHaveLength(0);
		});

		it("path exactly at viewport boundary (maxRow === startRow) is included", () => {
			const path = makePath({ minRow: 0, maxRow: 10 });
			const result = getVisibleOverlayElements([path], [], 10, 20);
			expect(result.paths).toHaveLength(1);
		});

		it("path exactly at viewport boundary (minRow === endRow) is included", () => {
			const path = makePath({ minRow: 10, maxRow: 20 });
			const result = getVisibleOverlayElements([path], [], 0, 10);
			expect(result.paths).toHaveLength(1);
		});

		it("multiple visible paths are all included", () => {
			const paths = [
				makePath({ minRow: 0, maxRow: 5 }),
				makePath({ minRow: 3, maxRow: 10 }),
				makePath({ minRow: 7, maxRow: 15 }),
			];
			const result = getVisibleOverlayElements(paths, [], 4, 8);
			expect(result.paths).toHaveLength(3);
		});

		it("out-of-range paths are filtered, in-range are kept", () => {
			const paths = [
				makePath({ minRow: 0, maxRow: 5 }), // excluded
				makePath({ minRow: 10, maxRow: 15 }), // included
				makePath({ minRow: 3, maxRow: 3 }), // excluded
				makePath({ minRow: 12, maxRow: 12 }), // included
			];
			const result = getVisibleOverlayElements(paths, [], 10, 15);
			expect(result.paths).toHaveLength(2);
		});
	});

	describe("node (dot) visibility", () => {
		it("node at row 5 is included when visible range is [3, 8]", () => {
			const node = makeNode({ y: 5 });
			const result = getVisibleOverlayElements([], [node], 3, 8);
			expect(result.dots).toHaveLength(1);
		});

		it("node at row 5 is excluded when visible range is [10, 20]", () => {
			const node = makeNode({ y: 5 });
			const result = getVisibleOverlayElements([], [node], 10, 20);
			expect(result.dots).toHaveLength(0);
		});

		it("node at startRow is included", () => {
			const node = makeNode({ y: 10 });
			const result = getVisibleOverlayElements([], [node], 10, 20);
			expect(result.dots).toHaveLength(1);
		});

		it("node at endRow is included", () => {
			const node = makeNode({ y: 20 });
			const result = getVisibleOverlayElements([], [node], 10, 20);
			expect(result.dots).toHaveLength(1);
		});
	});

	describe("pill visibility", () => {
		/** Factory: minimal OverlayRefPill for visibility testing */
		function makePill(rowIndex: number): OverlayRefPill {
			return {
				x: 4,
				y: rowIndex * 36 + 18,
				width: 60,
				textWidth: 52,
				height: 20,
				name: "refs/heads/main",
				label: "main",
				truncatedLabel: "main",
				refType: "LocalBranch",
				colorIndex: 0,
				isHead: true,
				isRemoteOnly: false,
				isNonHead: false,
				overflowCount: 0,
				allRefs: [] as RefLabel[],
				dotCx: 8,
				dotCy: rowIndex * 36 + 18,
				commitColorIndex: 0,
				rowIndex,
				isHollow: false,
			};
		}

		it("pills filtered correctly by rowIndex range", () => {
			const pills = [makePill(2), makePill(5), makePill(8), makePill(12)];
			const result = getVisibleOverlayElements([], [], 4, 9, pills);
			expect(result.pills).toHaveLength(2);
			expect(result.pills.map((p) => p.rowIndex)).toEqual([5, 8]);
		});

		it("pills at boundary rows are included", () => {
			const pills = [makePill(5), makePill(10)];
			const result = getVisibleOverlayElements([], [], 5, 10, pills);
			expect(result.pills).toHaveLength(2);
		});

		it("pills parameter defaults to empty array", () => {
			const result = getVisibleOverlayElements([], [], 0, 10);
			expect(result.pills).toEqual([]);
		});
	});
});
