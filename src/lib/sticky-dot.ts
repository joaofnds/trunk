import { EDGE_FADE_WIDTH } from "./graph-constants.js";

/**
 * How far the rails fade before the graph column's right edge, for a rail band
 * of this width. Capped at half the band: at the one-lane floor a full-width
 * fade would swallow most of the rail, which reads worse than the hard edge it
 * replaces.
 */
export function edgeFadeWidth(bandWidth: number): number {
	return Math.min(EDGE_FADE_WIDTH, bandWidth / 2);
}
