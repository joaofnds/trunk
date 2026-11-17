/** The scroll offset that centres row `index` in a viewport `viewportHeight` tall. */
export function centredRowTop(
	index: number,
	rowHeight: number,
	viewportHeight: number,
): number {
	return Math.max(0, index * rowHeight - viewportHeight / 2 + rowHeight / 2);
}

/**
 * Where the graph opens. While HEAD's row is on the first screen the graph stays at
 * the top, so the WIP row, which always leads the list, and the branch tips above
 * HEAD stay in view. Further down, HEAD is centred.
 */
export function openingScrollTop(
	headIndex: number,
	rowHeight: number,
	viewportHeight: number,
): number {
	if ((headIndex + 1) * rowHeight <= viewportHeight) return 0;
	return centredRowTop(headIndex, rowHeight, viewportHeight);
}
