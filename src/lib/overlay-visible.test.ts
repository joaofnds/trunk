import { describe, expect, it } from "vitest";
import { buildOverlayPaths } from "./overlay-paths.js";
import { getVisibleOverlayElements } from "./overlay-visible.js";
import type {
	OverlayConnection,
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

		it("upward connector is kept once its parent row scrolls off the top", () => {
			const conn: OverlayConnection = {
				childX: 1,
				childY: 3,
				parentX: 0,
				parentY: 0,
				colorIndex: 0,
				dashed: true,
			};
			const paths = buildOverlayPaths({
				nodes: [],
				connections: [conn],
				maxColumns: 2,
			});

			const result = getVisibleOverlayElements(paths, [], 1, 30);

			expect(result.paths).toHaveLength(1);
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

		it("a lane's pill is kept as a ghost once its row scrolls above", () => {
			// GitKraken keeps a branch's name against its lane while the lane is on
			// screen and the branch tip is not. Without it the lane of a branch far
			// behind its upstream carries no name for hundreds of rows (TRUNK-87).
			const pills = [makePill(0)];
			const paths = [makePath({ minRow: 0, maxRow: 40 })];

			const result = getVisibleOverlayElements(
				paths,
				[makeNode({ y: 0, x: 0 })],
				10,
				20,
				pills,
				[{ column: 0, minRow: 0, maxRow: 40 }],
			);

			expect(result.pills).toHaveLength(1);
			expect(result.pills[0]).toMatchObject({
				label: "main",
				rowIndex: 10,
				isGhost: true,
			});
		});

		it("a ghost pill sits on the first visible row", () => {
			const pills = [makePill(0)];

			const result = getVisibleOverlayElements(
				[],
				[makeNode({ y: 0, x: 0 })],
				7,
				20,
				pills,
				[{ column: 0, minRow: 0, maxRow: 40 }],
				36,
			);

			expect(result.pills[0].y).toBe(7 * 36 + 18);
			expect(result.pills[0].dotCy).toBe(7 * 36 + 18);
		});

		it("no ghost while the pill's own row is visible", () => {
			const pills = [makePill(12)];

			const result = getVisibleOverlayElements(
				[],
				[makeNode({ y: 12, x: 0 })],
				10,
				20,
				pills,
				[{ column: 0, minRow: 0, maxRow: 40 }],
			);

			expect(result.pills).toHaveLength(1);
			expect(result.pills[0].rowIndex).toBe(12);
			expect(result.pills[0].isGhost).toBeFalsy();
		});

		it("no ghost once the lane itself has ended above", () => {
			const pills = [makePill(0)];

			const result = getVisibleOverlayElements(
				[],
				[makeNode({ y: 0, x: 0 })],
				10,
				20,
				pills,
				[{ column: 0, minRow: 0, maxRow: 5 }],
			);

			expect(result.pills).toHaveLength(0);
		});

		it("only the nearest ref above becomes a lane's ghost", () => {
			const older = makePill(0);
			const nearer = { ...makePill(4), label: "near", name: "refs/heads/near" };

			const result = getVisibleOverlayElements(
				[],
				[makeNode({ y: 0, x: 0 }), makeNode({ y: 4, x: 0 })],
				10,
				20,
				[older, nearer],
				[{ column: 0, minRow: 0, maxRow: 40 }],
			);

			expect(result.pills).toHaveLength(1);
			expect(result.pills[0].label).toBe("near");
		});

		it("ghosts on one row are laid out side by side, in lane order", () => {
			const right = { ...makePill(0), dotCx: 24, width: 40 };
			const left = { ...makePill(1), dotCx: 8, width: 50, label: "main" };

			const result = getVisibleOverlayElements(
				[],
				[makeNode({ y: 0, x: 1 }), makeNode({ y: 1, x: 0 })],
				10,
				20,
				[right, left],
				[
					{ column: 0, minRow: 0, maxRow: 40 },
					{ column: 1, minRow: 0, maxRow: 40 },
				],
			);

			const ghosts = result.pills.filter((p) => p.isGhost);
			expect(ghosts).toHaveLength(2);
			expect(ghosts[0].dotCx).toBe(8);
			expect(ghosts[1].x).toBe(ghosts[0].x + ghosts[0].width + 4);
		});

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
