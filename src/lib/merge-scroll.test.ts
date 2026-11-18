import { describe, expect, it } from "vitest";
import { conflictNearest, layoutFrom, mapOffset } from "./merge-scroll";

describe("layoutFrom", () => {
	it("stacks each region below the one before it", () => {
		expect(layoutFrom([10, 0, 30])).toEqual([0, 10, 10, 40]);
	});
});

describe("mapOffset", () => {
	const sides = layoutFrom([100, 50, 100]);
	const output = layoutFrom([100, 20, 100]);

	it("keeps a region's lines lined up where both panes draw it alike", () => {
		expect(mapOffset(sides, output, 40)).toBe(40);
	});

	it("moves through a region at the same fraction of its height", () => {
		expect(mapOffset(sides, output, 125)).toBe(110);
	});

	it("lines up the regions after one drawn at different heights", () => {
		expect(mapOffset(sides, output, 160)).toBe(130);
	});

	it("maps back to the same place", () => {
		expect(mapOffset(output, sides, 130)).toBe(160);
	});

	it("holds still through a region the other pane does not draw", () => {
		const empty = layoutFrom([100, 0, 100]);

		expect([110, 140].map((y) => mapOffset(sides, empty, y))).toEqual([
			100, 100,
		]);
	});

	it("skips a region it does not draw when mapping the other way", () => {
		const empty = layoutFrom([100, 0, 100]);

		expect(mapOffset(empty, sides, 100)).toBe(150);
	});

	it("moves both panes together past the last region", () => {
		expect(mapOffset(sides, output, 260)).toBe(230);
	});

	it("passes the offset through when there are no regions", () => {
		expect(mapOffset(layoutFrom([]), layoutFrom([]), 12)).toBe(12);
	});
});

describe("conflictNearest", () => {
	it("picks the conflict whose header is nearest the middle", () => {
		expect(conflictNearest([100, 400, 900], 600)).toBe(1);
	});

	it("picks the first conflict above every header", () => {
		expect(conflictNearest([100, 400], 0)).toBe(0);
	});

	it("picks the last conflict below every header", () => {
		expect(conflictNearest([100, 400], 5000)).toBe(1);
	});
});
