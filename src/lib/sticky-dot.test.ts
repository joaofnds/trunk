import { describe, expect, it } from "vitest";
import { EDGE_FADE_WIDTH, LANE_WIDTH } from "./graph-constants.js";
import { edgeFadeWidth } from "./sticky-dot.js";

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
