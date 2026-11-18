/**
 * Scroll correspondence between the merge editor's two side panes and its
 * output. The sides draw every region at one aligned height; the output holds
 * only the lines the selection keeps. A region therefore spans a different
 * height in each, and the same pixel offset points at different lines.
 *
 * A layout is the top of each region in one pane plus the bottom of the last,
 * so region `r` spans `[tops[r], tops[r + 1])`.
 */
export type RegionLayout = readonly number[];

/** The tops of each region in a pane whose regions are `heights` tall. */
export function layoutFrom(heights: readonly number[]): RegionLayout {
	const tops = new Array<number>(heights.length + 1);
	tops[0] = 0;
	for (let r = 0; r < heights.length; r++) tops[r + 1] = tops[r] + heights[r];
	return tops;
}

/**
 * The offset in `to` that shows what `y` shows in `from`: the same region, at
 * the same fraction of its height. A region with no height in `to` (a conflict
 * nothing was taken from) holds `to` still while `from` scrolls through it.
 * Past the last region the two move together.
 */
export function mapOffset(
	from: RegionLayout,
	to: RegionLayout,
	y: number,
): number {
	const last = from.length - 1;
	if (last <= 0) return y;
	if (y >= from[last]) return to[last] + (y - from[last]);
	if (y <= 0) return 0;
	let lo = 0;
	let hi = last - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (from[mid] <= y) lo = mid;
		else hi = mid - 1;
	}
	const height = from[lo + 1] - from[lo];
	const fraction = height === 0 ? 0 : (y - from[lo]) / height;
	return to[lo] + fraction * (to[lo + 1] - to[lo]);
}

/**
 * The index of the conflict whose header is nearest the viewport's middle,
 * given each conflict header's centre in document order.
 */
export function conflictNearest(
	headerCentres: readonly number[],
	middle: number,
): number {
	let best = 0;
	for (let i = 1; i < headerCentres.length; i++) {
		if (
			Math.abs(headerCentres[i] - middle) <
			Math.abs(headerCentres[best] - middle)
		)
			best = i;
	}
	return best;
}
