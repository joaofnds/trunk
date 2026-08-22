import { describe, expect, it } from "vitest";
import { buildOffsets, windowFor } from "./virtual-window.js";

const uniform = (count: number, height: number) =>
	buildOffsets(new Array(count).fill(height));

describe("buildOffsets", () => {
	it("starts at zero so the first row's top is the content top", () => {
		expect(buildOffsets([10, 20, 30])[0]).toBe(0);
	});

	it("gives each row the sum of every row above it", () => {
		expect(Array.from(buildOffsets([10, 20, 30]))).toEqual([0, 10, 30, 60]);
	});

	it("ends at the total height of every row", () => {
		const offsets = buildOffsets([10, 20, 30]);

		expect(offsets[offsets.length - 1]).toBe(60);
	});

	it("holds one entry for an empty list", () => {
		expect(Array.from(buildOffsets([]))).toEqual([0]);
	});
});

describe("windowFor", () => {
	it("covers the viewport from the top of an unscrolled list", () => {
		const view = windowFor(uniform(1000, 20), 0, 100, 0);

		expect(view.start).toBe(0);
		expect(view.end).toBe(5);
	});

	it("keeps covering the viewport when rows are far taller than the overscan", () => {
		const tall = buildOffsets(new Array(1000).fill(500));

		const view = windowFor(tall, 0, 2000, 0);

		expect(view.end - view.start).toBe(4);
	});

	it("reports the total height of every row, not only the rendered ones", () => {
		expect(windowFor(uniform(1000, 20), 0, 100, 0).totalHeight).toBe(20_000);
	});

	it("positions the rendered block at the top of its first row", () => {
		expect(windowFor(uniform(1000, 20), 500, 100, 0).offsetTop).toBe(500);
	});

	it("starts at the row the scroll position lands inside, not the one after", () => {
		expect(windowFor(uniform(1000, 20), 510, 100, 0).start).toBe(25);
	});

	it("extends the block by a pixel runway on both sides", () => {
		const view = windowFor(uniform(1000, 20), 500, 100, 60);

		expect(view.start).toBe(22);
		expect(view.end).toBe(33);
	});

	it("measures the runway in pixels, so tall rows do not shrink it", () => {
		const mixed = buildOffsets([
			...new Array(10).fill(200),
			...new Array(10).fill(20),
		]);

		const view = windowFor(mixed, 1000, 100, 400);

		expect(view.start).toBe(3);
	});

	it("never starts before the first row", () => {
		expect(windowFor(uniform(1000, 20), 0, 100, 200).start).toBe(0);
	});

	it("never ends past the last row", () => {
		expect(windowFor(uniform(10, 20), 0, 1000, 200).end).toBe(10);
	});

	it("renders nothing for an empty list", () => {
		const view = windowFor(buildOffsets([]), 0, 100, 80);

		expect(view.end - view.start).toBe(0);
		expect(view.totalHeight).toBe(0);
	});

	describe("when rows have different heights", () => {
		// Tops: 0, 10, 110, 130, 630.
		const varied = buildOffsets([10, 100, 20, 500, 10]);

		it("finds the row containing the scroll position rather than dividing by an average", () => {
			expect(windowFor(varied, 120, 5, 0).start).toBe(2);
		});

		it("counts short rows individually instead of assuming an average height", () => {
			const shortThenTall = buildOffsets([10, 10, 10, 10, 10, 500]);

			expect(windowFor(shortThenTall, 0, 50, 0).end).toBe(5);
		});

		it("renders a single row when one row taller than the viewport covers it", () => {
			const view = windowFor(varied, 200, 100, 0);

			expect(view.start).toBe(3);
			expect(view.end).toBe(4);
		});

		it("positions the block by real offsets, so the first row meets the scroll position", () => {
			expect(windowFor(varied, 130, 20, 0).offsetTop).toBe(130);
		});
	});

	describe("at the boundaries", () => {
		it("clamps a negative scroll position to the first row", () => {
			expect(windowFor(uniform(100, 20), -50, 100, 0).start).toBe(0);
		});

		it("stays on the last row when scrolled past the end", () => {
			const view = windowFor(uniform(100, 20), 99_999, 100, 0);

			expect(view.end).toBe(100);
			expect(view.start).toBe(99);
		});

		it("renders the first row when the viewport has no height yet", () => {
			expect(windowFor(uniform(100, 20), 0, 0, 0).end).toBe(1);
		});
	});
});
