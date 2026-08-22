export interface VirtualWindow {
	/** First row index to render, inclusive. */
	start: number;
	/** Last row index to render, exclusive. */
	end: number;
	/** Distance from the top of the content to the top of row `start`. */
	offsetTop: number;
	totalHeight: number;
}

/** Cumulative row tops. `offsets[i]` is the top of row `i`, so row `i` occupies
 *  `[offsets[i], offsets[i + 1])` and `offsets[n]` is the total height. */
export function buildOffsets(heights: ArrayLike<number>): Float64Array {
	const offsets = new Float64Array(heights.length + 1);

	let running = 0;
	for (let index = 0; index < heights.length; index++) {
		running += heights[index];
		offsets[index + 1] = running;
	}

	return offsets;
}

/** The largest index whose top satisfies the bound: `<= bound` locates the row
 *  containing a position, `< bound` locates the last row starting above one. A
 *  row whose top sits exactly on the viewport's bottom edge is not visible. */
function lastIndexWithin(
	offsets: Float64Array,
	bound: number,
	inclusive: boolean,
): number {
	let low = 0;
	let high = offsets.length - 1;

	while (low < high) {
		const mid = (low + high + 1) >> 1;
		const within = inclusive ? offsets[mid] <= bound : offsets[mid] < bound;
		if (within) low = mid;
		else high = mid - 1;
	}

	return low;
}

/** The rows covering the viewport, derived rather than estimated: with exact
 *  heights there is nothing to measure afterwards and nothing to correct.
 *
 *  Overscan is pixels, never a row count. Rows here differ in height by an order
 *  of magnitude, so "8 rows" buys an unpredictable amount of runway and a fast
 *  drag outruns it. */
export function windowFor(
	offsets: Float64Array,
	scrollTop: number,
	viewportHeight: number,
	overscanPx: number,
): VirtualWindow {
	const count = offsets.length - 1;
	if (count <= 0) {
		return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
	}

	const totalHeight = offsets[count];
	const runway = Math.max(0, overscanPx);
	const top = Math.max(0, scrollTop - runway);
	const bottom = Math.max(
		top,
		scrollTop + Math.max(0, viewportHeight) + runway,
	);

	const start = Math.min(count - 1, lastIndexWithin(offsets, top, true));
	const last = Math.min(count - 1, lastIndexWithin(offsets, bottom, false));
	const end = Math.min(count, Math.max(start + 1, last + 1));

	return { start, end, offsetTop: offsets[start], totalHeight };
}
