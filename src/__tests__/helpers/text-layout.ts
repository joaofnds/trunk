/**
 * jsdom lays out nothing, so whether a cell's text is cut has to be told to it.
 * `layOutText` says how wide the text is (what a Range over it reports) and how
 * wide the box showing it is (its own rect). clientWidth rounds to a whole pixel,
 * as a browser's does.
 *
 * Call `restoreTextLayout()` in `afterEach`: the text width sits on
 * Range.prototype and would otherwise leak into every later test in the file.
 * It puts back whatever was there, a suite's own polyfill included.
 */

const original = Object.getOwnPropertyDescriptor(
	Range.prototype,
	"getBoundingClientRect",
);

export function layOutText(
	el: HTMLElement,
	textWidth: number,
	boxWidth: number,
): void {
	Range.prototype.getBoundingClientRect = () =>
		({ width: textWidth }) as DOMRect;
	el.getBoundingClientRect = () => ({ width: boxWidth }) as DOMRect;
	Object.defineProperty(el, "clientWidth", {
		value: Math.round(boxWidth),
		configurable: true,
	});
}

export function restoreTextLayout(): void {
	if (original) {
		Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
	} else {
		delete (Range.prototype as Partial<Range>).getBoundingClientRect;
	}
}
