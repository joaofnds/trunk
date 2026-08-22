export interface RowMetrics {
	charWidthPx: number;
	lineHeightPx: number;
	monospace: boolean;
}

const PROBE_RUN = 100;

/** The diff row's own font, in one place: the rows render with it, and every
 *  probe that measures it has to carry the same declaration or it measures a
 *  different font. Line height is stated in px rather than as a multiple
 *  because `getComputedStyle` resolves the multiple in a browser and returns it
 *  raw elsewhere, which silently turns 1.5 into 1.5px. */
export const DIFF_ROW_FONT =
	"font-family: monospace; font-size: 12px; line-height: 18px";

/** Reads the metrics a wrapped row's height depends on from an element already
 *  carrying the row's own styles, so a change to the diff font, size or line
 *  spacing is picked up rather than baked in. `monospace` is false when the
 *  configured font advances "i" and "W" differently, which is the condition
 *  under which character-count arithmetic stops being exact. */
export function measureRowMetrics(probe: HTMLElement): RowMetrics {
	const style = getComputedStyle(probe);

	const narrow = runWidth(probe, "i");
	const wide = runWidth(probe, "W");
	const zero = runWidth(probe, "0");

	return {
		charWidthPx: zero / PROBE_RUN,
		lineHeightPx: resolveLineHeight(style),
		monospace: Math.abs(narrow - wide) < 0.5,
	};
}

function runWidth(probe: HTMLElement, char: string): number {
	const span = document.createElement("span");
	span.style.position = "absolute";
	span.style.visibility = "hidden";
	span.style.whiteSpace = "pre";
	span.style.flex = "0 0 auto";
	span.textContent = char.repeat(PROBE_RUN);

	probe.appendChild(span);
	const width = span.getBoundingClientRect().width;
	probe.removeChild(span);

	return width;
}

function resolveLineHeight(style: CSSStyleDeclaration): number {
	const declared = Number.parseFloat(style.lineHeight);
	if (Number.isFinite(declared)) return declared;

	return Number.parseFloat(style.fontSize) * 1.2;
}

/** Exact rendered height of one row, by character count rather than by
 *  measuring it after it mounts. */
export function rowHeightFor(
	contentChars: number,
	availableChars: number,
	metrics: RowMetrics,
): number {
	if (availableChars <= 0) return metrics.lineHeightPx;

	const visualLines = Math.max(1, Math.ceil(contentChars / availableChars));

	return visualLines * metrics.lineHeightPx;
}

/** Zero means "not computable here", never "one column". An unmeasured pane
 *  reporting a single column would make every row wrap to its character count,
 *  which looks like a height rather than like a missing measurement. */
export function availableCharsFor(
	paneWidthPx: number,
	gutterChars: number,
	paddingPx: number,
	metrics: RowMetrics,
): number {
	if (metrics.charWidthPx <= 0 || paneWidthPx <= 0) return 0;

	const textWidth = paneWidthPx - paddingPx - gutterChars * metrics.charWidthPx;
	if (textWidth < metrics.charWidthPx) return 0;

	return Math.floor(textWidth / metrics.charWidthPx);
}
