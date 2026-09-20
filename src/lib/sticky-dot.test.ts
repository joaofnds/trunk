import { describe, expect, it } from "vitest";
import {
	COLUMN_PADDING_X,
	DOT_RADIUS,
	EDGE_FADE_WIDTH,
	LANE_WIDTH,
} from "./graph-constants.js";
import { edgeFadeWidth, stickyDotX } from "./sticky-dot.js";

const settings = { laneWidth: LANE_WIDTH, dotRadius: DOT_RADIUS };

/** The centre of lane `col` in unscrolled graph coordinates. */
function laneCentre(col: number): number {
	return col * LANE_WIDTH + LANE_WIDTH / 2;
}

describe("stickyDotX", () => {
	const wide = 10 * LANE_WIDTH;

	it("leaves a dot on its own lane centre when the column has room", () => {
		expect(stickyDotX(laneCentre(2), wide, 0, settings)).toBe(laneCentre(2));
	});

	it("follows the pan by shifting against the scroll", () => {
		expect(stickyDotX(laneCentre(3), wide, LANE_WIDTH, settings)).toBe(
			laneCentre(3) - LANE_WIDTH,
		);
	});

	describe("when the dot would fall off the left edge", () => {
		it("holds it at the first lane's centre", () => {
			expect(stickyDotX(laneCentre(0), wide, 5 * LANE_WIDTH, settings)).toBe(
				LANE_WIDTH / 2,
			);
		});
	});

	describe("when the dot would fall off the right edge", () => {
		// Both bounds must be lane centres. A right bound measured to the dot's
		// edge instead parks clamped dots a few pixels off the lane the unclamped
		// ones sit on, and the column reads as two ragged rows of dots.
		it("holds it a lane's half-width inside the right edge", () => {
			const colWidth = 4 * LANE_WIDTH;

			expect(stickyDotX(laneCentre(9), colWidth, 0, settings)).toBe(
				colWidth - 2 * COLUMN_PADDING_X - LANE_WIDTH / 2,
			);
		});

		it("parks a clamped dot on the same x as one resting there naturally", () => {
			const colWidth = 4 * LANE_WIDTH;
			const rightmost = colWidth - 2 * COLUMN_PADDING_X - LANE_WIDTH / 2;

			const clamped = stickyDotX(laneCentre(9), colWidth, 0, settings);
			const resting = stickyDotX(rightmost, colWidth, 0, settings);

			expect(clamped).toBe(resting);
		});
	});

	// At the one-lane floor the two bounds meet. They must agree, or every dot
	// in the column sits on one of two x positions a couple of pixels apart.
	describe("at a column only one lane wide", () => {
		it("puts every dot on the same x", () => {
			const colWidth = LANE_WIDTH + 2 * COLUMN_PADDING_X;
			const positions = [0, 1, 2, 5, 9].map((col) =>
				stickyDotX(laneCentre(col), colWidth, 0, settings),
			);

			expect(new Set(positions).size).toBe(1);
		});
	});
});

describe("edgeFadeWidth", () => {
	it("fades over its full width when the band has room", () => {
		expect(edgeFadeWidth(10 * LANE_WIDTH)).toBe(EDGE_FADE_WIDTH);
	});

	// At the one-lane floor a full-width fade would swallow most of the band and
	// leave the rail barely visible, which is worse than the hard edge it
	// replaces.
	it("never takes more than half a narrow band", () => {
		const band = LANE_WIDTH;

		expect(edgeFadeWidth(band)).toBe(band / 2);
	});
});
