import type { GraphDisplaySettings } from './types.js';

export const LANE_WIDTH = 16;
export const ROW_HEIGHT = 26;
export const DOT_RADIUS = 6;
export const EDGE_STROKE = 1.5;
export const MERGE_STROKE = 2;

/** Default graph display settings. Pass to buildOverlayPaths / buildRefPillData.
 *  When a settings page is added, load user prefs and spread over these defaults. */
export const DEFAULT_GRAPH_SETTINGS: GraphDisplaySettings = {
  rowHeight: ROW_HEIGHT,
  laneWidth: LANE_WIDTH,
  dotRadius: DOT_RADIUS,
  edgeStroke: EDGE_STROKE,
  mergeStroke: MERGE_STROKE,
};

// Ref pill constants
export const PILL_HEIGHT = 20;
export const PILL_PADDING_X = 6;
export const PILL_FONT_SIZE = 11;
export const PILL_FONT = '500 11px Inter, system-ui, -apple-system, sans-serif';
export const PILL_FONT_BOLD = '700 11px Inter, system-ui, -apple-system, sans-serif';
export const PILL_GAP = 4;
export const PILL_MARGIN_LEFT = 4;
export const BADGE_HEIGHT = 16;
export const BADGE_FONT_SIZE = 10;
export const ICON_WIDTH = 10;
