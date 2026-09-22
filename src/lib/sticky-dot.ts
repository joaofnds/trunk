import { COLUMN_PADDING_X, EDGE_FADE_WIDTH } from "./graph-constants.js";

/** The geometry a clamped dot needs: its lane's width and its own radius. */
export interface StickyDotSettings {
	laneWidth: number;
	dotRadius: number;
}

/**
 * Where a dot renders once the graph column is panned, so it stays visible
 * while its rail scrolls out from under it (bead-on-a-string). `graphX` is the
 * dot's unscrolled centre.
 *
 * Both bounds are lane centres. Measuring the right one to the dot's edge
 * instead parks clamped dots off the lane the unclamped ones sit on, which at
 * the one-lane floor splits every dot in the column across two x positions.
 */
export function stickyDotX(
	graphX: number,
	colWidth: number,
	scroll: number,
	settings: StickyDotSettings,
): number {
	const halfLane = settings.laneWidth / 2;
	const rightmost = colWidth - 2 * COLUMN_PADDING_X - halfLane;

	return Math.max(halfLane, Math.min(rightmost, graphX - scroll));
}

/**
 * How far the rails fade before the graph column's right edge, for a rail band
 * of this width. Capped at half the band: at the one-lane floor a full-width
 * fade would swallow most of the rail, which reads worse than the hard edge it
 * replaces.
 */
export function edgeFadeWidth(bandWidth: number): number {
	return Math.min(EDGE_FADE_WIDTH, bandWidth / 2);
}
