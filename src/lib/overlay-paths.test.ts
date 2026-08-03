import { describe, expect, it } from "vitest";
import {
	DEFAULT_GRAPH_SETTINGS,
	DOT_RADIUS,
	LANE_WIDTH,
	ROW_HEIGHT,
} from "./graph-constants.js";
import { buildOverlayPaths, makePathContext } from "./overlay-paths.js";
import type {
	OverlayConnection,
	OverlayGraphData,
	OverlayNode,
} from "./types.js";

// Coordinate helpers — derived from graph-constants so they stay in sync automatically
const LANE = LANE_WIDTH;
const ROW = ROW_HEIGHT;
const R = LANE / 2; // corner radius = laneWidth / 2
const DOT_R = DOT_RADIUS;
const DASH_GAP = 3; // matches stroke-dasharray gap
const KAPPA = (4 * (Math.SQRT2 - 1)) / 3; // bezier quarter-circle constant
function cx(col: number): number {
	return col * LANE + LANE / 2;
}
function cy(row: number): number {
	return row * ROW + ROW / 2;
}

/** Every y-coordinate in a path made of M, V, C and H commands */
function pathYs(d: string): number[] {
	const tokens = d.split(" ");
	const ys: number[] = [];
	let i = 0;
	while (i < tokens.length) {
		const command = tokens[i++];
		if (command === "M") {
			i++;
			ys.push(Number(tokens[i++]));
		} else if (command === "V") {
			ys.push(Number(tokens[i++]));
		} else if (command === "C") {
			for (let point = 0; point < 3; point++) {
				i++;
				ys.push(Number(tokens[i++]));
			}
		} else if (command === "H") {
			i++;
		} else {
			throw new Error(`unexpected path command: ${command}`);
		}
	}
	return ys;
}

/** Factory: minimal OverlayConnection */
function makeConn(
	overrides: Partial<OverlayConnection> & {
		childX: number;
		childY: number;
		parentX: number;
		parentY: number;
	},
): OverlayConnection {
	return {
		childX: overrides.childX,
		childY: overrides.childY,
		parentX: overrides.parentX,
		parentY: overrides.parentY,
		colorIndex: overrides.colorIndex ?? 0,
		dashed: overrides.dashed ?? false,
	};
}

/** Factory: minimal OverlayNode */
function makeNode(
	overrides: Partial<OverlayNode> & { oid: string; x: number; y: number },
): OverlayNode {
	return {
		oid: overrides.oid,
		x: overrides.x,
		y: overrides.y,
		colorIndex: overrides.colorIndex ?? 0,
		isMerge: overrides.isMerge ?? false,
		isBranchTip: overrides.isBranchTip ?? false,
		isStash: overrides.isStash ?? false,
		isWip: overrides.isWip ?? false,
	};
}

/** Build minimal OverlayGraphData */
function makeGraphData(
	connections: OverlayConnection[],
	nodes: OverlayNode[] = [],
	maxColumns = 4,
): OverlayGraphData {
	return { nodes, connections, maxColumns };
}

describe("buildOverlayPaths", () => {
	describe("empty input", () => {
		it("returns empty array for empty connections", () => {
			const result = buildOverlayPaths(makeGraphData([]));
			expect(result).toEqual([]);
		});

		it("returns empty array for empty connections with nodes present", () => {
			const nodes = [makeNode({ oid: "a", x: 0, y: 0 })];
			const result = buildOverlayPaths(makeGraphData([], nodes));
			expect(result).toEqual([]);
		});
	});

	describe("same-column paths (vertical lines)", () => {
		it("produces M...V path from child cy to parent cy", () => {
			const conn = makeConn({ childX: 0, childY: 0, parentX: 0, parentY: 3 });
			const result = buildOverlayPaths(makeGraphData([conn]));

			expect(result).toHaveLength(1);
			expect(result[0].d).toBe(`M ${cx(0)} ${cy(0)} V ${cy(3)}`);
		});

		it("carries colorIndex through", () => {
			const conn = makeConn({
				childX: 1,
				childY: 0,
				parentX: 1,
				parentY: 1,
				colorIndex: 3,
			});
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].colorIndex).toBe(3);
		});

		it("carries dashed flag through", () => {
			const conn = makeConn({
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 2,
				dashed: true,
			});
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].dashed).toBe(true);
		});

		it("solid connection has dashed=false", () => {
			const conn = makeConn({
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 2,
				dashed: false,
			});
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].dashed).toBe(false);
		});

		it("hollow stash tip child: starts at dot edge + dash gap", () => {
			const conn = makeConn({
				childX: 0,
				childY: 1,
				parentX: 0,
				parentY: 3,
				dashed: true,
			});
			const nodes = [
				makeNode({
					oid: "stash",
					x: 0,
					y: 1,
					isBranchTip: true,
					isStash: true,
				}),
			];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toBe(
				`M ${cx(0)} ${cy(1) + DOT_R + DASH_GAP} V ${cy(3)}`,
			);
		});

		it("hollow merge tip parent: ends at dot edge - dash gap", () => {
			const conn = makeConn({ childX: 0, childY: 0, parentX: 0, parentY: 2 });
			const nodes = [
				makeNode({
					oid: "merge",
					x: 0,
					y: 2,
					isBranchTip: true,
					isMerge: true,
				}),
			];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toBe(
				`M ${cx(0)} ${cy(0)} V ${cy(2) - DOT_R - DASH_GAP}`,
			);
		});

		it("hollow WIP child: starts at dot edge + dash gap", () => {
			const conn = makeConn({
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 2,
				dashed: true,
			});
			const nodes = [makeNode({ oid: "wip", x: 0, y: 0, isWip: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toBe(
				`M ${cx(0)} ${cy(0) + DOT_R + DASH_GAP} V ${cy(2)}`,
			);
		});

		it("filled normal tip: starts at cy (no gap)", () => {
			const conn = makeConn({ childX: 0, childY: 0, parentX: 0, parentY: 2 });
			const nodes = [makeNode({ oid: "tip", x: 0, y: 0, isBranchTip: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toBe(`M ${cx(0)} ${cy(0)} V ${cy(2)}`);
		});

		it("in column 2 uses cx(2) for x coordinate", () => {
			const conn = makeConn({ childX: 2, childY: 0, parentX: 2, parentY: 1 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toBe(`M ${cx(2)} ${cy(0)} V ${cy(1)}`);
		});

		it("produces one path per connection", () => {
			const conns = [
				makeConn({ childX: 0, childY: 0, parentX: 0, parentY: 2 }),
				makeConn({ childX: 1, childY: 0, parentX: 1, parentY: 3 }),
			];
			const result = buildOverlayPaths(makeGraphData(conns));
			expect(result).toHaveLength(2);
		});
	});

	describe("cross-column paths (vertical + curve + horizontal)", () => {
		it("starts at cx(childX), cy(childY)", () => {
			const conn = makeConn({ childX: 0, childY: 1, parentX: 2, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toMatch(new RegExp(`^M ${cx(0)} ${cy(1)}`));
		});

		it("contains V, C, and H segments", () => {
			const conn = makeConn({ childX: 0, childY: 1, parentX: 2, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toContain("V");
			expect(result[0].d).toContain("C");
			expect(result[0].d).toContain("H");
		});

		it("vertical segment stops R above parent row center", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 1, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toContain(`V ${cy(5) - R}`);
		});

		it("curve corner is at cy(parentY) in child column", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 1, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			// Bezier end point: cx(childX) + R toward parent, cy(parentY)
			const hStart = cx(0) + R; // going right
			expect(result[0].d).toContain(`${hStart} ${cy(5)}`);
		});

		it("horizontal ends at parent cx", () => {
			const conn = makeConn({ childX: 0, childY: 1, parentX: 2, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toContain(`H ${cx(2)}`);
		});

		it("horizontal ends at hollow parent dot edge - dash gap", () => {
			const conn = makeConn({ childX: 0, childY: 1, parentX: 2, parentY: 5 });
			const nodes = [
				makeNode({
					oid: "merge",
					x: 2,
					y: 5,
					isBranchTip: true,
					isMerge: true,
				}),
			];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			// going right → stops at cx(2) - (DOT_R + DASH_GAP)
			expect(result[0].d).toContain(`H ${cx(2) - DOT_R - DASH_GAP}`);
		});

		it("left-going: starts at cx(childX), cy(childY)", () => {
			const conn = makeConn({ childX: 2, childY: 1, parentX: 0, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toMatch(new RegExp(`^M ${cx(2)} ${cy(1)}`));
		});

		it("left-going: horizontal ends at parent cx", () => {
			const conn = makeConn({ childX: 2, childY: 1, parentX: 0, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].d).toContain(`H ${cx(0)}`);
		});

		it("hollow child tip: vertical starts at dot edge + dash gap", () => {
			const conn = makeConn({ childX: 1, childY: 0, parentX: 0, parentY: 3 });
			const nodes = [
				makeNode({
					oid: "stash",
					x: 1,
					y: 0,
					isBranchTip: true,
					isStash: true,
				}),
			];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toMatch(
				new RegExp(`^M ${cx(1)} ${cy(0) + DOT_R + DASH_GAP}`),
			);
		});

		it("multiple cross-column connections produce separate paths", () => {
			const conns = [
				makeConn({ childX: 0, childY: 0, parentX: 1, parentY: 3 }),
				makeConn({ childX: 0, childY: 0, parentX: 2, parentY: 5 }),
			];
			const result = buildOverlayPaths(makeGraphData(conns));
			expect(result).toHaveLength(2);
		});

		it("carries colorIndex through", () => {
			const conn = makeConn({
				childX: 0,
				childY: 1,
				parentX: 2,
				parentY: 5,
				colorIndex: 5,
			});
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].colorIndex).toBe(5);
		});

		it("carries dashed flag through", () => {
			const conn = makeConn({
				childX: 0,
				childY: 1,
				parentX: 2,
				parentY: 5,
				dashed: true,
			});
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].dashed).toBe(true);
		});
	});

	describe("merge cross-column paths (horizontal + curve + vertical)", () => {
		it("starts at cx(childX), cy(childY)", () => {
			const conn = makeConn({ childX: 1, childY: 0, parentX: 0, parentY: 3 });
			const nodes = [makeNode({ oid: "merge", x: 1, y: 0, isMerge: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toMatch(new RegExp(`^M ${cx(1)} ${cy(0)}`));
		});

		it("horizontal segment stops R before parent column", () => {
			// merge at col 1, parent at col 0 (going left)
			const conn = makeConn({ childX: 1, childY: 0, parentX: 0, parentY: 3 });
			const nodes = [makeNode({ oid: "merge", x: 1, y: 0, isMerge: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			// going left: hTarget = cx(0) + R
			expect(result[0].d).toContain(`H ${cx(0) + R}`);
		});

		it("curve corner at parent column, cy(childY) + R", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 1, parentY: 5 });
			const nodes = [makeNode({ oid: "merge", x: 0, y: 2, isMerge: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			const cornerY = cy(2) + R;
			expect(result[0].d).toContain(`${cx(1)} ${cornerY}`);
		});

		it("vertical tail ends at parent cy", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 1, parentY: 5 });
			const nodes = [makeNode({ oid: "merge", x: 0, y: 2, isMerge: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toContain(`V ${cy(5)}`);
		});

		it("vertical tail ends at hollow parent dot edge - dash gap", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 1, parentY: 5 });
			const nodes = [
				makeNode({ oid: "merge", x: 0, y: 2, isMerge: true }),
				makeNode({ oid: "tip", x: 1, y: 5, isBranchTip: true, isMerge: true }),
			];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toContain(`V ${cy(5) - DOT_R - DASH_GAP}`);
		});

		it("contains H, C, and V segments", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 1, parentY: 5 });
			const nodes = [makeNode({ oid: "merge", x: 0, y: 2, isMerge: true })];
			const result = buildOverlayPaths(makeGraphData([conn], nodes));
			expect(result[0].d).toContain("H");
			expect(result[0].d).toContain("C");
			expect(result[0].d).toContain("V");
		});
	});

	describe("upward connections (parent above child)", () => {
		describe("same column", () => {
			it("runs from the child's top edge to the parent's bottom edge", () => {
				const conn = makeConn({
					childX: 0,
					childY: 2,
					parentX: 0,
					parentY: 0,
					dashed: true,
				});
				const nodes = [
					makeNode({
						oid: "stash",
						x: 0,
						y: 2,
						isBranchTip: true,
						isStash: true,
					}),
					makeNode({
						oid: "merge",
						x: 0,
						y: 0,
						isBranchTip: true,
						isMerge: true,
					}),
				];

				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				expect(result[0].d).toBe(
					`M ${cx(0)} ${cy(2) - DOT_R - DASH_GAP} V ${cy(0) + DOT_R + DASH_GAP}`,
				);
			});

			it("runs to the parent centre when the parent is filled", () => {
				const conn = makeConn({
					childX: 0,
					childY: 2,
					parentX: 0,
					parentY: 0,
					dashed: true,
				});
				const nodes = [
					makeNode({
						oid: "stash",
						x: 0,
						y: 2,
						isBranchTip: true,
						isStash: true,
					}),
					makeNode({ oid: "parent", x: 0, y: 0 }),
				];

				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				expect(result[0].d).toBe(
					`M ${cx(0)} ${cy(2) - DOT_R - DASH_GAP} V ${cy(0)}`,
				);
			});
		});

		describe("fork", () => {
			const conn = makeConn({
				childX: 1,
				childY: 3,
				parentX: 0,
				parentY: 0,
				dashed: true,
			});
			const nodes = [
				makeNode({
					oid: "stash",
					x: 1,
					y: 3,
					isBranchTip: true,
					isStash: true,
				}),
				makeNode({ oid: "parent", x: 0, y: 0 }),
			];

			it("rises from the child's top edge and turns at the parent row", () => {
				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				const cp1y = cy(0) + (1 - KAPPA) * R;
				const cp2x = cx(1) - KAPPA * R;
				expect(result[0].d).toBe(
					`M ${cx(1)} ${cy(3) - DOT_R - DASH_GAP} V ${cy(0) + R} ` +
						`C ${cx(1)} ${cp1y} ${cp2x} ${cy(0)} ${cx(1) - R} ${cy(0)} H ${cx(0)}`,
				);
			});

			it("never rises above the parent row", () => {
				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				expect(Math.min(...pathYs(result[0].d))).toBe(cy(0));
			});
		});

		describe("merge", () => {
			const conn = makeConn({ childX: 0, childY: 3, parentX: 1, parentY: 0 });
			const nodes = [
				makeNode({ oid: "merge", x: 0, y: 3, isMerge: true }),
				makeNode({
					oid: "parent",
					x: 1,
					y: 0,
					isBranchTip: true,
					isMerge: true,
				}),
			];

			it("turns its corner above the child row", () => {
				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				const cp1x = cx(1) - (1 - KAPPA) * R;
				const cp2y = cy(3) - KAPPA * R;
				expect(result[0].d).toBe(
					`M ${cx(0)} ${cy(3)} H ${cx(1) - R} ` +
						`C ${cp1x} ${cy(3)} ${cx(1)} ${cp2y} ${cx(1)} ${cy(3) - R} ` +
						`V ${cy(0) + DOT_R + DASH_GAP}`,
				);
			});

			it("never drops below the child row", () => {
				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				expect(Math.max(...pathYs(result[0].d))).toBe(cy(3));
			});
		});
	});

	describe("minRow/maxRow metadata", () => {
		it("same-column: minRow=childY, maxRow=parentY", () => {
			const conn = makeConn({ childX: 0, childY: 2, parentX: 0, parentY: 5 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].minRow).toBe(2);
			expect(result[0].maxRow).toBe(5);
		});

		it("cross-column: minRow=childY, maxRow=parentY", () => {
			const conn = makeConn({ childX: 0, childY: 3, parentX: 1, parentY: 7 });
			const result = buildOverlayPaths(makeGraphData([conn]));
			expect(result[0].minRow).toBe(3);
			expect(result[0].maxRow).toBe(7);
		});

		describe("when the parent sits above the child", () => {
			it("same-column: minRow=parentY, maxRow=childY", () => {
				const conn = makeConn({ childX: 0, childY: 3, parentX: 0, parentY: 0 });

				const result = buildOverlayPaths(makeGraphData([conn]));

				expect(result[0].minRow).toBe(0);
				expect(result[0].maxRow).toBe(3);
			});

			it("fork: minRow=parentY, maxRow=childY", () => {
				const conn = makeConn({ childX: 1, childY: 3, parentX: 0, parentY: 0 });

				const result = buildOverlayPaths(makeGraphData([conn]));

				expect(result[0].minRow).toBe(0);
				expect(result[0].maxRow).toBe(3);
			});

			it("merge: minRow=parentY, maxRow=childY", () => {
				const conn = makeConn({ childX: 0, childY: 3, parentX: 1, parentY: 0 });
				const nodes = [makeNode({ oid: "merge", x: 0, y: 3, isMerge: true })];

				const result = buildOverlayPaths(makeGraphData([conn], nodes));

				expect(result[0].minRow).toBe(0);
				expect(result[0].maxRow).toBe(3);
			});
		});
	});

	describe("output fields", () => {
		it("all paths have d, colorIndex, dashed, minRow, maxRow", () => {
			const conns = [
				makeConn({ childX: 0, childY: 0, parentX: 0, parentY: 2 }),
				makeConn({ childX: 0, childY: 1, parentX: 1, parentY: 5 }),
			];
			const result = buildOverlayPaths(makeGraphData(conns));
			for (const path of result) {
				expect(path).toHaveProperty("d");
				expect(path).toHaveProperty("colorIndex");
				expect(path).toHaveProperty("dashed");
				expect(path).toHaveProperty("minRow");
				expect(path).toHaveProperty("maxRow");
				expect(typeof path.d).toBe("string");
			}
		});
	});
});

describe("makePathContext", () => {
	it("centers a column in its lane", () => {
		expect(makePathContext(DEFAULT_GRAPH_SETTINGS).cx(2)).toBe(
			2 * LANE + LANE / 2,
		);
	});

	it("centers a row in its height", () => {
		expect(makePathContext(DEFAULT_GRAPH_SETTINGS).cy(3)).toBe(
			3 * ROW + ROW / 2,
		);
	});

	// The overlay is placed against the row height VirtualList measured, which at
	// non-100% zoom is not the CSS constant. Callers pass those settings in.
	it("takes the row height from the settings it is given", () => {
		const measured = { ...DEFAULT_GRAPH_SETTINGS, rowHeight: 25.5 };

		expect(makePathContext(measured).cy(4)).toBe(4 * 25.5 + 25.5 / 2);
	});
});
