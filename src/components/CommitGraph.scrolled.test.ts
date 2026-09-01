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

	async function scrolledToRow(
		row: number,
		{ stashRows = [], rowHeight = ROW_HEIGHT } = {} as {
			stashRows?: number[];
			rowHeight?: number;
		},
	) {
		const graph = await mountScrolledGraph(
			tallFixture(FIXTURE_ROWS, stashRows),
			{ viewportHeight: VIEWPORT_HEIGHT, rowHeight },
		);
		close = graph.unmount;

		await graph.scrollTo(row * rowHeight);
		return graph;
	}

	/**
	 * The rows are given a height the component cannot arrive at by guessing.
	 *
	 * `defaultEstimatedItemHeight` is `ROW_HEIGHT`, so a list that never measures
	 * anything still lays out at 28 and an assertion of 28 passes either way. It
	 * cannot tell a correct measurement from no measurement at all, which is the
	 * failure this whole card exists to close. Ask for 34 and only a list that
	 * really read the DOM can produce it.
	 */
	it("lays the rows out at the height it measured, not at its own estimate", async () => {
		const MEASURED = ROW_HEIGHT + 6;

		const graph = await scrolledToRow(SCROLL_TO_ROW, { rowHeight: MEASURED });

		expect(graph.rowHeight()).toBe(MEASURED);
	});

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
		const graph = await scrolledToRow(SCROLL_TO_ROW, {
			stashRows: [SCROLL_TO_ROW + 2],
		});

		expect(graph.rowHeight()).toBe(ROW_HEIGHT);
	});

	/**
	 * A second mount measured its rows one at a time, and the list discards a
	 * one-sample average, so the overlay silently kept painting at the estimate
	 * while the first mount in the file passed. Under load the same split reached
	 * the first mount too. Two mounts is the smallest case that shows it.
	 */
	it("measures its rows again on a second mount in the same file", async () => {
		const MEASURED = ROW_HEIGHT + 6;

		const graph = await scrolledToRow(SCROLL_TO_ROW, { rowHeight: MEASURED });

		expect(graph.rowHeight()).toBe(MEASURED);
	});

	it("moves the rendered window down when the viewport scrolls", async () => {
		const graph = await scrolledToRow(SCROLL_TO_ROW);

		expect(Math.min(...dotRows(graph.svg))).toBeGreaterThan(0);
	});

	/**
	 * The row indices read back off the overlay are the list's own indices, at any
	 * row height. Reading them against `ROW_HEIGHT` instead of against the height
	 * the overlay was painted at scales every index by the ratio between the two,
	 * silently: at 34px the window starting at row 80 reads back as row 97.
	 */
	it("reads back the list's own row indices at a non-default row height", async () => {
		const MEASURED = ROW_HEIGHT + 6;

		const graph = await scrolledToRow(SCROLL_TO_ROW, { rowHeight: MEASURED });

		const painted = Math.min(...dotRows(graph.svg));
		const rendered = Number(
			document.querySelector<HTMLElement>("[data-original-index]")?.dataset
				.originalIndex,
		);

		expect(painted).toBe(rendered);
	});
});
