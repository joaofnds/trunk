/**
 * The layout jsdom does not do, for a mounted `VirtualList`.
 *
 * `VirtualList` reads two different heights from the DOM and jsdom returns 0 for
 * both: the scroll viewport's content box, which sets how many rows fit, and each
 * rendered row's own box, which it averages into the row height every offset is
 * computed from. A stub that answers one number for every element conflates them.
 * At 4000 for both, the list measured a 4000px row, one row filled the viewport,
 * and the visible range stayed pinned at 0 whatever viewport height it was given —
 * which is why no test in this repository could exercise a scrolled graph, and why
 * TRUNK-87 shipped two features that never rendered past all 121 render goldens.
 *
 * So measure by role instead. The viewport gets the height the test asked for, a
 * row gets the real row height, and the list's own arithmetic decides the rest.
 */

import { ROW_HEIGHT } from "../../lib/chrome-heights.js";
import { type LayoutBox, restoreLayout, stubLayout } from "./layout-stub.js";

/** Taller than any fixture's content, so every row fits and nothing is culled.
 *  The render goldens mount at this height and are pinned to the unscrolled
 *  state; a shorter viewport there would move all 121 of them. */
export const UNSCROLLED_VIEWPORT_HEIGHT = 4000;

/** `HunkView` withholds its rows entirely until the pane measures wider than
 *  zero, so a diff opened under a headless DOM renders no hunks at all. */
export const VIEWPORT_WIDTH = 1200;

export interface VirtualListLayoutOptions {
	/** The scroll viewport's height. Shorter than the content means the list
	 *  scrolls and culls, which is the state goldens cannot reach. */
	viewportHeight?: number;
	/** The height one rendered row measures. The list averages these into the
	 *  row height it lays every offset out from. */
	rowHeight?: number;
	width?: number;
}

/**
 * Installs the role-aware layout for every element in the document. Pair with
 * `restoreVirtualListLayout()` in a teardown hook: the stubs sit on the
 * prototypes and leak into every later suite.
 */
export function stubVirtualListLayout(
	options: VirtualListLayoutOptions = {},
): void {
	const {
		viewportHeight = UNSCROLLED_VIEWPORT_HEIGHT,
		rowHeight = ROW_HEIGHT,
		width = VIEWPORT_WIDTH,
	} = options;

	installReportingResizeObserver();
	stubLayout({
		width,
		height: viewportHeight,
		measure: (el) => measureByRole(el, viewportHeight, rowHeight, width),
	});
}

/**
 * Undoes everything `stubVirtualListLayout` installed, the layout descriptors
 * and the observer alike.
 *
 * `restoreLayout()` alone is not enough and looks like it is. It restores the
 * five layout descriptors and leaves the reporting observer in place, so a suite
 * that cleaned up by that route still hands the next one an observer that fires
 * — and suites elsewhere in this repository are written against jsdom's
 * do-nothing stub.
 */
export function restoreVirtualListLayout(): void {
	restoreLayout();

	if (!installedObserver) return;
	installedObserver = false;
	if (priorObserver === undefined) {
		Reflect.deleteProperty(globalThis, "ResizeObserver");
	} else {
		globalThis.ResizeObserver = priorObserver;
	}
	priorObserver = undefined;
}

/**
 * A `ResizeObserver` that reports its first observation, the way a real one does.
 *
 * The repo-wide stub in `vitest-setup.ts` swallows `observe()` entirely, so
 * `VirtualList` is never told a row has a size and its measurement path never
 * runs at all: the row height stays whatever `defaultEstimatedItemHeight` said,
 * and no layout stub of any shape can change it. That makes a wrong measured
 * height unobservable, which is the second half of why a scrolled graph could not
 * be tested here.
 *
 * Reports asynchronously, as the real one does — a synchronous callback would
 * fire mid-`bind:this` before the element is in `itemElements`, and be dropped.
 */
function installReportingResizeObserver(): void {
	if (installedObserver) return;
	installedObserver = true;
	priorObserver = globalThis.ResizeObserver;

	globalThis.ResizeObserver = class ReportingResizeObserver {
		#targets = new Set<Element>();
		#pending = new Set<Element>();
		#scheduled = false;
		#callback: ResizeObserverCallback;

		constructor(callback: ResizeObserverCallback) {
			this.#callback = callback;
		}

		observe(target: Element) {
			this.#targets.add(target);
			this.#pending.add(target);
			if (this.#scheduled) return;

			// One callback for every element observed in this turn, the way a real
			// observer delivers a batch. Reporting each element in its own callback
			// instead lets the list's debounced measurement fire on a set of one,
			// and it discards a one-sample average outright — so the measured height
			// is computed correctly and then thrown away, and the overlay keeps
			// painting at the estimate.
			this.#scheduled = true;
			queueMicrotask(() => {
				this.#scheduled = false;
				const batch = [...this.#pending].filter((el) => this.#targets.has(el));
				this.#pending.clear();
				if (batch.length === 0) return;

				this.#callback(batch.map(entryFor), this as unknown as ResizeObserver);
			});
		}

		unobserve(target: Element) {
			this.#targets.delete(target);
			this.#pending.delete(target);
		}

		disconnect() {
			this.#targets.clear();
			this.#pending.clear();
		}
	} as unknown as typeof ResizeObserver;
}

let installedObserver = false;
let priorObserver: typeof ResizeObserver | undefined;

/**
 * A resize entry carrying the box the layout stub reports for the element.
 *
 * The list's own callbacks re-measure off `target` and ignore the rest, but
 * `contentRect` is the idiomatic way to read a `ResizeObserver`, so an entry
 * without one hands the next consumer `undefined` on a line that looks right.
 */
function entryFor(target: Element): ResizeObserverEntry {
	const rect = target.getBoundingClientRect();
	const box = { blockSize: rect.height, inlineSize: rect.width };

	return {
		target,
		contentRect: rect,
		borderBoxSize: [box],
		contentBoxSize: [box],
		devicePixelContentBoxSize: [box],
	} as ResizeObserverEntry;
}

/**
 * The three roles that measure differently. Everything else keeps the shared
 * default box, which is what the pre-existing stub gave every element.
 *
 * A row is identified by `data-original-index`, the attribute `VirtualList`
 * itself puts on each item wrapper — the same one its `ResizeObserver` reads
 * back. Matching on that rather than on a class keeps this stub tied to the
 * contract the component already depends on.
 */
function measureByRole(
	el: Element,
	viewportHeight: number,
	rowHeight: number,
	width: number,
): Partial<LayoutBox> | undefined {
	if (el.matches("[data-original-index]")) return { height: rowHeight, width };

	if (el.matches(".virtual-list-viewport, .virtual-list-container")) {
		return { height: viewportHeight, width };
	}

	// The content element is as tall as the list made it: it carries an inline
	// `height` the list computes from the row height and the item count, and
	// reporting the viewport's height there would hide every overflow.
	if (el.matches(".virtual-list-content")) {
		return { height: inlineHeight(el) ?? viewportHeight, width };
	}

	return undefined;
}

function inlineHeight(el: Element): number | undefined {
	const declared = (el as HTMLElement).style?.height;
	if (!declared?.endsWith("px")) return undefined;

	const parsed = Number.parseFloat(declared);
	return Number.isFinite(parsed) ? parsed : undefined;
}
