import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	dotRows,
	dots,
	mountScrolledGraph,
	tallFixture,
	warmGraphComponent,
} from "../__tests__/helpers/graph-render";
import { ROW_HEIGHT } from "../lib/chrome-heights.js";

/**
 * The suite the render goldens cannot be: a viewport shorter than the fixture, so
 * the list scrolls, `visibleStart` leaves 0, and the overlay culls. Every golden
 * mounts taller than any fixture and pins the unscrolled state only — which is how
 * TRUNK-87 shipped two features that never rendered, past all 121 of them.
 */
describe("the commit graph scrolled", () => {
	beforeAll(warmGraphComponent, 30_000);

	// Well past VirtualList's 20-row buffer plus the ~8 rows a 200px viewport
	// holds, so a scrolled window is a strict subset of the fixture.
	const FIXTURE_ROWS = 200;
	const VIEWPORT_HEIGHT = 200;
	const SCROLL_TO_ROW = 100;

	let close: (() => void) | null = null;
	afterEach(() => {
		close?.();
		close = null;
	});

	async function scrolledToRow(row: number, stashRows: number[] = []) {
		const graph = await mountScrolledGraph(
			tallFixture(FIXTURE_ROWS, stashRows),
			{ viewportHeight: VIEWPORT_HEIGHT },
		);
		close = graph.unmount;

		await graph.scrollTo(row * ROW_HEIGHT);
		return graph;
	}

	it("lays the rows out at the real row height, not the viewport height", async () => {
		const graph = await scrolledToRow(SCROLL_TO_ROW);

		expect(graph.rowHeight()).toBe(ROW_HEIGHT);
	});

	it("renders a window sized to the viewport, not to the fixture", async () => {
		const graph = await scrolledToRow(SCROLL_TO_ROW);

		// A window sized to the viewport is a small fraction of this fixture: the
		// viewport holds about 8 rows, and the list buffers a bounded number more
		// either side. Half the fixture is far above any of that, and far below
		// the whole 200 a list that ignored its viewport height would draw. The
		// bound is deliberately loose about the buffer, which belongs to
		// VirtualList and is not this test's subject.
		expect(dots(graph.svg).length).toBeLessThan(FIXTURE_ROWS / 2);
	});

	// A stash is the one node the overlay draws as a <rect>, whose `y` is the top
	// edge rather than the centre a <circle> puts in `cy`. A window holding both
	// shapes is the only place a reader that confuses the two shows up.
	it("measures the row height across a window mixing a stash with commits", async () => {
		const graph = await scrolledToRow(SCROLL_TO_ROW, [SCROLL_TO_ROW + 2]);

		expect(graph.rowHeight()).toBe(ROW_HEIGHT);
	});

	it("moves the rendered window down when the viewport scrolls", async () => {
		const graph = await scrolledToRow(SCROLL_TO_ROW);

		expect(Math.min(...dotRows(graph.svg))).toBeGreaterThan(0);
	});
});
