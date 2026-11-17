import { describe, expect, it } from "vitest";
import { centredRowTop, openingScrollTop } from "./graph-scroll.js";

describe("openingScrollTop", () => {
	it("stays at the top while HEAD's row is on the first screen", () => {
		expect(openingScrollTop(1, { rowHeight: 28, viewportHeight: 600 })).toBe(0);
	});

	it("stays at the top when HEAD's row ends exactly at the bottom edge", () => {
		expect(openingScrollTop(9, { rowHeight: 28, viewportHeight: 280 })).toBe(0);
	});

	it("centres HEAD once its row is below the first screen", () => {
		expect(openingScrollTop(10, { rowHeight: 28, viewportHeight: 280 })).toBe(
			154,
		);
	});
});

describe("centredRowTop", () => {
	it("never scrolls above the first row", () => {
		expect(centredRowTop(2, { rowHeight: 28, viewportHeight: 600 })).toBe(0);
	});

	it("puts the row's middle at the viewport's middle", () => {
		expect(centredRowTop(50, { rowHeight: 20, viewportHeight: 400 })).toBe(810);
	});
});
