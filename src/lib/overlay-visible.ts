import { ROW_HEIGHT } from "./graph-constants.js";
import type { OverlayNode, OverlayPath, OverlayRefPill } from "./types.js";

/** Which column a lane holds, and over which rows. */
export interface LaneSpan {
	column: number;
	minRow: number;
	maxRow: number;
}

export interface VisibleOverlayElements {
	paths: OverlayPath[];
	dots: OverlayNode[];
	pills: OverlayRefPill[];
}

export function getVisibleOverlayElements(
	paths: OverlayPath[],
	nodes: OverlayNode[],
	startRow: number,
	endRow: number,
	pills: OverlayRefPill[] = [],
	lanes: LaneSpan[] = [],
	rowHeight: number = ROW_HEIGHT,
): VisibleOverlayElements {
	const visiblePaths: OverlayPath[] = [];

	for (const path of paths) {
		if (path.maxRow >= startRow && path.minRow <= endRow) {
			visiblePaths.push(path);
		}
	}

	const dots = nodes.filter((n) => n.y >= startRow && n.y <= endRow);
	const visiblePills = pills.filter(
		(p) => p.rowIndex >= startRow && p.rowIndex <= endRow,
	);

	return {
		paths: visiblePaths,
		dots,
		pills: [
			...visiblePills,
			...ghostPills(pills, nodes, lanes, startRow, rowHeight),
		],
	};
}

/**
 * A pill kept against its lane after its own row has scrolled above.
 *
 * A lane can run for hundreds of rows — a branch far behind its upstream holds
 * its column from its tip down to a parent well past the first page — and once
 * that tip scrolls away the line carries no name at all. GitKraken keeps the
 * branch's name pinned to the lane for as long as the lane is on screen; this is
 * that, reusing the ordinary pill so a ghost and a real pill render through one
 * path (TRUNK-87).
 *
 * One ghost per lane, taken from the nearest ref above the viewport, so a column
 * reused by several branches names the one whose history the visible rows belong
 * to.
 */
function ghostPills(
	pills: OverlayRefPill[],
	nodes: OverlayNode[],
	lanes: LaneSpan[],
	startRow: number,
	rowHeight: number,
): OverlayRefPill[] {
	if (lanes.length === 0) return [];

	const columnByRow = new Map<number, number>();
	for (const node of nodes) columnByRow.set(node.y, node.x);

	const ghosts: OverlayRefPill[] = [];

	for (const lane of lanes) {
		// A lane that already ended above the viewport has nothing on screen to name.
		if (lane.maxRow < startRow) continue;

		let nearest: OverlayRefPill | undefined;
		for (const pill of pills) {
			if (pill.rowIndex >= startRow) continue;
			if (pill.rowIndex < lane.minRow) continue;
			if (columnByRow.get(pill.rowIndex) !== lane.column) continue;
			if (!nearest || pill.rowIndex > nearest.rowIndex) nearest = pill;
		}

		if (!nearest) continue;

		// Re-pinned to the first visible row, coordinates and all: the pill layer
		// draws from y and dotCy, so shifting rowIndex alone would leave the ghost
		// painted at its original row. The shift is the same for both, which keeps
		// the connector meeting the lane at the row the ghost now sits on.
		const dy = (startRow - nearest.rowIndex) * rowHeight;
		ghosts.push({
			...nearest,
			rowIndex: startRow,
			y: nearest.y + dy,
			dotCy: nearest.dotCy + dy,
			isGhost: true,
		});
	}

	// Real pills never collide because each sits on its own row. Every ghost pins
	// to the same row, so they are laid out left to right instead, in lane order
	// so the strip reads in the same order as the lanes it names.
	ghosts.sort((a, b) => a.dotCx - b.dotCx);

	let x = ghosts[0]?.x ?? 0;
	for (const ghost of ghosts) {
		ghost.x = x;
		x += ghost.width + GHOST_GAP;
	}

	return ghosts;
}

/** Horizontal gap between two ghosts sharing the viewport's first row. */
const GHOST_GAP = 4;
