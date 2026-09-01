import { ROW_HEIGHT, UNIT } from "./chrome-heights.js";
import type { GraphDisplaySettings } from "./types.js";

/* A graph row is a list row; the value belongs with the other chrome heights.
   Re-exported so the graph pipeline's public names are unchanged. */
export { ROW_HEIGHT };
export const LANE_WIDTH = 4 * UNIT;
export const DOT_RADIUS = 6;
export const EDGE_STROKE = 1.5;
export const MERGE_STROKE = 2;
export const PILL_STROKE = 1;

/** Default graph display settings. Pass to buildOverlayPaths / buildRefPillData.
 *  When a settings page is added, load user prefs and spread over these defaults. */
export const DEFAULT_GRAPH_SETTINGS: GraphDisplaySettings = {
	rowHeight: ROW_HEIGHT,
	laneWidth: LANE_WIDTH,
	dotRadius: DOT_RADIUS,
	edgeStroke: EDGE_STROKE,
	mergeStroke: MERGE_STROKE,
	pillStroke: PILL_STROKE,
};

// Column layout constants
export const COLUMN_PADDING_X = 4;

// Ref pill constants
export const PILL_HEIGHT = 5 * UNIT;
export const PILL_PADDING_X = 6;
export const PILL_FONT_SIZE = 11;
export const PILL_FONT = "500 11px Inter, system-ui, -apple-system, sans-serif";
export const PILL_FONT_BOLD =
	"700 11px Inter, system-ui, -apple-system, sans-serif";
export const PILL_GAP = 4;
export const PILL_MARGIN_LEFT = 4;
export const BADGE_HEIGHT = 4 * UNIT;
export const BADGE_FONT_SIZE = 10;
export const ICON_WIDTH = 10;
export const ICON_GAP = 2; // flex gap between icon and text in pill foreignObject
