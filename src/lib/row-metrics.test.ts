import { describe, expect, it } from "vitest";
import { availableCharsFor, rowHeightFor } from "./row-metrics.js";

const metrics = { charWidthPx: 10, lineHeightPx: 20, monospace: true };

describe("availableCharsFor", () => {
	it("fits the characters left after the gutter and the padding", () => {
		expect(availableCharsFor(1000, 10, 16, metrics)).toBe(88);
	});

	it("reports nothing computable when the pane has not been measured", () => {
		expect(availableCharsFor(0, 10, 16, metrics)).toBe(0);
	});

	it("reports nothing computable when the gutter leaves no room for text", () => {
		expect(availableCharsFor(100, 10, 16, metrics)).toBe(0);
	});

	it("reports nothing computable when the font has no measured width", () => {
		expect(
			availableCharsFor(1000, 10, 16, { ...metrics, charWidthPx: 0 }),
		).toBe(0);
	});
});

describe("rowHeightFor", () => {
	it("gives a line that fits one visual row", () => {
		expect(rowHeightFor(50, 100, metrics)).toBe(20);
	});

	it("gives an exactly-filling line one visual row", () => {
		expect(rowHeightFor(100, 100, metrics)).toBe(20);
	});

	it("gives a line one character too long a second visual row", () => {
		expect(rowHeightFor(101, 100, metrics)).toBe(40);
	});

	it("gives an empty line one visual row", () => {
		expect(rowHeightFor(0, 100, metrics)).toBe(20);
	});

	it("falls back to a single row when the column count is unknown", () => {
		expect(rowHeightFor(5000, 0, metrics)).toBe(20);
	});
});
