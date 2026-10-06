/** How many `--lane-N` colours tokens.css declares; a lane past them reuses one. */
const LANE_COUNT = 8;

export function laneColor(colorIndex: number): string {
	return `var(--lane-${colorIndex % LANE_COUNT})`;
}
