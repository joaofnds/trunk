import { beforeEach, describe, expect, it } from "vitest";
import {
	measureTextWidth,
	resetCache,
	truncateMiddle,
} from "./text-measure.js";

/** Mock measure function: each char = 7px width */
const mockMeasure = (text: string, _font: string): number => text.length * 7;

describe("measureTextWidth", () => {
	beforeEach(() => {
		resetCache();
	});

	it("returns consistent positive number", () => {
		const width = measureTextWidth("hello", "test-font", mockMeasure);
		expect(width).toBeGreaterThan(0);
		expect(width).toBe(5 * 7);
	});

	it("caches results (same input returns same value)", () => {
		let callCount = 0;
		const countingMeasure = (text: string, _font: string): number => {
			callCount++;
			return text.length * 7;
		};

		const first = measureTextWidth("hello", "test-font", countingMeasure);
		const second = measureTextWidth("hello", "test-font", countingMeasure);
		expect(first).toBe(second);
		expect(callCount).toBe(1);
	});

	it("returns different results for different fonts", () => {
		const fontAwareMeasure = (text: string, font: string): number =>
			text.length * (font === "big" ? 14 : 7);
		const small = measureTextWidth("abc", "small", fontAwareMeasure);
		const big = measureTextWidth("abc", "big", fontAwareMeasure);
		expect(small).not.toBe(big);
		expect(big).toBe(small * 2);
	});

	it("resetCache clears cached measurements", () => {
		let callCount = 0;
		const countingMeasure = (text: string, _font: string): number => {
			callCount++;
			return text.length * 7;
		};

		measureTextWidth("test", "font", countingMeasure);
		expect(callCount).toBe(1);
		resetCache();
		measureTextWidth("test", "font", countingMeasure);
		expect(callCount).toBe(2);
	});
});

describe("truncateMiddle", () => {
	it("returns full text when it fits within maxWidth", () => {
		const result = truncateMiddle("hi", 100, "test-font", mockMeasure);
		expect(result.text).toBe("hi");
		expect(result.width).toBe(14);
	});

	it("cuts the middle out, keeping the head and the tail", () => {
		const result = truncateMiddle("abcdef", 35, "test-font", mockMeasure);

		expect(result).toEqual({ text: "ab…ef", width: 35 });
	});

	it("gives the tail the odd character, since it tells names apart", () => {
		const result = truncateMiddle("abcdef", 30, "test-font", mockMeasure);

		expect(result).toEqual({ text: "a…ef", width: 28 });
	});

	it("never splits a character written in two code units", () => {
		const result = truncateMiddle("🍎🍏🍐🍊", 42, "test-font", mockMeasure);

		expect(result).toEqual({ text: "🍎…🍊", width: 35 });
	});

	it('returns just "…" when the ellipsis fits but no character beside it does', () => {
		// "…" = 7px fits in 10px; one char + ellipsis = 14px does not
		const result = truncateMiddle("abcdef", 10, "test-font", mockMeasure);
		expect(result).toEqual({ text: "…", width: 7 });
	});

	// Returning the ellipsis anyway drew text wider than the room it was given,
	// which in a ref pill painted past the capsule.
	it.each([5, 0])(
		"returns nothing when not even the ellipsis fits in %ipx",
		(maxWidth) => {
			const result = truncateMiddle(
				"abcdef",
				maxWidth,
				"test-font",
				mockMeasure,
			);
			expect(result).toEqual({ text: "", width: 0 });
		},
	);

	it("handles empty string", () => {
		const result = truncateMiddle("", 100, "test-font", mockMeasure);
		expect(result.text).toBe("");
		expect(result.width).toBe(0);
	});

	it("handles single-character input that fits", () => {
		const result = truncateMiddle("a", 100, "test-font", mockMeasure);
		expect(result.text).toBe("a");
		expect(result.width).toBe(7);
	});
});
