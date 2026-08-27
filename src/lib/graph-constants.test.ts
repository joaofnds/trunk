import { describe, expect, it } from "vitest";
import { UNIT } from "./chrome-heights.js";
import {
	DOT_RADIUS,
	EDGE_STROKE,
	LANE_WIDTH,
	MERGE_STROKE,
	ROW_HEIGHT,
} from "./graph-constants.js";

describe("graph-constants", () => {
	describe("unified constants", () => {
		it("LANE_WIDTH is 16", () => expect(LANE_WIDTH).toBe(4 * UNIT));
		it("ROW_HEIGHT is one row of units", () =>
			expect(ROW_HEIGHT).toBe(7 * UNIT));
		it("keeps ROW_HEIGHT above the segment-inversion floor", () =>
			expect(ROW_HEIGHT).toBeGreaterThanOrEqual(18));
		it("DOT_RADIUS is 6", () => expect(DOT_RADIUS).toBe(6));
		it("EDGE_STROKE is 1.5", () => expect(EDGE_STROKE).toBe(1.5));
		it("MERGE_STROKE is 2", () => expect(MERGE_STROKE).toBe(2));
	});
});
