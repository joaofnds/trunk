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

	async function scrolledToRow(row: number) {
		const graph = await mountScrolledGraph(tallFixture(FIXTURE_ROWS), {
			viewportHeight: VIEWPORT_HEIGHT,
		});
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

		// The viewport holds ceil(200/28) rows and VirtualList buffers 20 either
		// side, so a viewport-sized window is about 48 of the fixture's 200 rows.
		// A window that tracks the fixture instead means the viewport height it
		// was given never reached the list.
		const viewportRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 2 * 20;

		expect(dots(graph.svg).length).toBeLessThanOrEqual(viewportRows + 4);
	});

	it("moves the rendered window down when the viewport scrolls", async () => {
		const graph = await scrolledToRow(SCROLL_TO_ROW);

		expect(Math.min(...dotRows(graph.svg))).toBeGreaterThan(0);
	});
});
