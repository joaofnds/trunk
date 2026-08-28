/**
 * The gaps a headless DOM leaves under the real component tree. Each one is a
 * polyfill here, never a change to the component: a component that grows an
 * `if (typeof x === "function")` guard to survive the harness is testing the
 * guard rather than the product.
 *
 * `setup()` installs these itself rather than leaning on a runner's setup hook,
 * so the harness boots the application under any runner (parent AC#10).
 */

/**
 * jsdom lays nothing out, so a `VirtualList` container measures zero high, its
 * visible range collapses to the buffer, and the commit graph renders 22 rows
 * however tall the fixture is. The truncated render is self-consistent, which
 * is what makes it worse than an empty one.
 */
const VIEWPORT_HEIGHT = 4000;

/**
 * The same gap one step further in: `HunkView` withholds its rows entirely
 * until the pane measures wider than zero, so a diff opened under a headless
 * DOM renders no hunks at all and reports nothing about it.
 */
const VIEWPORT_WIDTH = 1200;

/** Per-glyph rather than uniform, so two equal-length strings can measure
 *  differently the way they do in a proportional font. */
const WIDE_GLYPH = /[0-9mwMW]/;

export function installDomPolyfills(): void {
	installResizeObserver();
	installDialog();
	installAnimate();
	installScrolling();
	installLayout();
	installTextMeasurement();
}

function installResizeObserver(): void {
	if (typeof globalThis.ResizeObserver !== "undefined") return;

	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}

function installDialog(): void {
	if (typeof HTMLDialogElement === "undefined") return;

	if (typeof HTMLDialogElement.prototype.showModal !== "function") {
		HTMLDialogElement.prototype.showModal = function showModal() {
			this.setAttribute("open", "");
		};
	}
	if (typeof HTMLDialogElement.prototype.close !== "function") {
		HTMLDialogElement.prototype.close = function close() {
			this.removeAttribute("open");
		};
	}
}

function installAnimate(): void {
	if (typeof Element.prototype.animate !== "undefined") return;

	Element.prototype.animate = () =>
		({
			finished: Promise.resolve(),
			cancel() {},
			play() {},
			pause() {},
			reverse() {},
			addEventListener() {},
			removeEventListener() {},
			onfinish: null,
			oncancel: null,
		}) as unknown as Animation;
}

function installScrolling(): void {
	if (typeof Element.prototype.scrollTo === "undefined") {
		Element.prototype.scrollTo = () => {};
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => {};
	}
}

function installLayout(): void {
	Element.prototype.getBoundingClientRect = function stubbedRect(): DOMRect {
		return {
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 0,
			bottom: VIEWPORT_HEIGHT,
			width: 0,
			height: VIEWPORT_HEIGHT,
			toJSON: () => ({}),
		} as DOMRect;
	};

	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => VIEWPORT_WIDTH,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => VIEWPORT_HEIGHT,
	});
}

function installTextMeasurement(): void {
	if (typeof globalThis.OffscreenCanvas !== "undefined") return;

	globalThis.OffscreenCanvas = class {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			return {
				font: "",
				measureText: (text: string) => ({ width: measure(text) }),
			};
		}
	} as unknown as typeof OffscreenCanvas;
}

function measure(text: string): number {
	return [...text].reduce(
		(width, glyph) => width + (WIDE_GLYPH.test(glyph) ? 10 : 6),
		0,
	);
}
