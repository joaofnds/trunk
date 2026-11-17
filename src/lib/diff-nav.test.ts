import { describe, expect, it } from "vitest";
import { adjacentStop } from "./diff-nav.js";

// Three hunks whose headers sit at rows 0, 10 and 20.
const stops = [0, 10, 20];

describe("adjacentStop", () => {
	it("goes to the first stop below the row at the top", () => {
		expect(adjacentStop(stops, 4, 1, null)).toBe(1);
	});

	it("goes back to the last stop above the row at the top", () => {
		expect(adjacentStop(stops, 14, -1, null)).toBe(1);
	});

	it("passes the stop the top already sits on", () => {
		expect(adjacentStop(stops, 10, 1, null)).toBe(2);
		expect(adjacentStop(stops, 10, -1, null)).toBe(0);
	});

	// Near the end the list cannot scroll a stop to the top, so the top stays
	// where the previous jump left it and only the jump says where the reader is.
	it("steps on from the last jump while the view is where it left it", () => {
		expect(adjacentStop(stops, 15, 1, { ordinal: 1, top: 15 })).toBe(2);
		expect(adjacentStop(stops, 15, -1, { ordinal: 2, top: 15 })).toBe(1);
	});

	it("steps from the top once the reader has scrolled since the jump", () => {
		expect(adjacentStop(stops, 2, 1, { ordinal: 2, top: 15 })).toBe(1);
	});

	it("has nowhere to go past either end", () => {
		expect(adjacentStop(stops, 20, 1, null)).toBe(-1);
		expect(adjacentStop(stops, 0, -1, null)).toBe(-1);
		expect(adjacentStop(stops, 15, 1, { ordinal: 2, top: 15 })).toBe(-1);
		expect(adjacentStop([], 0, 1, null)).toBe(-1);
	});
});
