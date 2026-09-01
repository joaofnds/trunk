import { stubVirtualListLayout } from "../../../src/__tests__/helpers/virtual-list-layout.js";

/**
 * The gaps a headless DOM leaves under the real component tree. Each one is a
 * polyfill here, never a change to the component: a component that grows an
 * `if (typeof x === "function")` guard to survive the harness is testing the
 * guard rather than the product.
 *
 * `setup()` installs these itself rather than leaning on a runner's setup hook,
 * so the harness boots the application under any runner (parent AC#10).
 */

/** Per-glyph rather than uniform, so two equal-length strings can measure
 *  differently the way they do in a proportional font. */
const WIDE_GLYPH = /[0-9mwMW]/;

export function installDomPolyfills(options: DomOptions = {}): void {
	installDialog();
	installAnimate();
	installScrolling();
	installLayout(options);
	installTextMeasurement();
}

export interface DomOptions {
	/** The scroll viewport's height. Shorter than the list's content is what
	 *  makes it scroll and cull; the default fits every fixture unscrolled. */
	viewportHeight?: number;
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

/**
 * Measures by role rather than answering one height for every element, and
 * installs the `ResizeObserver` that reports its observations — see
 * `src/__tests__/helpers/virtual-list-layout.ts`, which the render-golden mount
 * shares. A stub that conflates the viewport with the rows it holds makes the
 * list measure a row as tall as the whole viewport, so one row fills it, the
 * visible range never leaves 0, and no test here can scroll anything.
 */
function installLayout(options: DomOptions): void {
	stubVirtualListLayout({ viewportHeight: options.viewportHeight });
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
