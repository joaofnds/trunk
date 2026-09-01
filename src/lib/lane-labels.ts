import { sortRefs } from "./ref-pill-data.js";
import type {
	GraphCommit,
	LaneLabel,
	OverlayConnection,
	OverlayNode,
} from "./types.js";

/** Which column a lane holds, and over which rows. */
export interface LaneSpan {
	column: number;
	minRow: number;
	maxRow: number;
	colorIndex: number;
}

/**
 * The vertical runs of each lane, taken from the connections that produced the
 * drawn paths. Only same-column connections hold a lane; a fork or a merge
 * crosses columns and belongs to neither.
 */
export function laneSpans(connections: OverlayConnection[]): LaneSpan[] {
	const spans: LaneSpan[] = [];
	for (const c of connections) {
		if (c.childX !== c.parentX) continue;
		spans.push({
			column: c.childX,
			minRow: Math.min(c.childY, c.parentY),
			maxRow: Math.max(c.childY, c.parentY),
			colorIndex: c.colorIndex,
		});
	}
	return spans;
}

/**
 * Name every lane crossing the viewport whose owning ref sits above it.
 *
 * A lane can run for hundreds of rows — a branch far behind its upstream holds
 * its column from its tip down to a parent well past the first page. Scrolled
 * into the middle of such a span the line carries no dot, no name and no visible
 * end, so nothing on screen says which branch it belongs to. These labels put
 * the name back on the lane, pinned at the top edge, and disappear once the
 * ref's own row is on screen and can speak for itself (TRUNK-87).
 *
 * The label is the nearest ref above the viewport, so a lane reused by several
 * branches names the one whose history the visible rows actually belong to.
 * Where a row carries more than one ref, `sortRefs` picks the same primary the
 * ref pill shows, keeping the two readings of a lane consistent.
 */
export function buildLaneLabels(
	nodes: OverlayNode[],
	commits: GraphCommit[],
	lanes: LaneSpan[],
	visibleStart: number,
	visibleEnd: number,
): LaneLabel[] {
	const nodeByRow = new Map<number, OverlayNode>();
	for (const node of nodes) nodeByRow.set(node.y, node);

	const labels: LaneLabel[] = [];
	const seen = new Set<number>();

	for (const lane of lanes) {
		if (seen.has(lane.column)) continue;
		// Only lanes actually crossing the viewport need naming.
		if (lane.maxRow < visibleStart || lane.minRow > visibleEnd) continue;

		// Walk up from the viewport to the nearest ref this lane passes through.
		// Stopping at the first one keeps the label describing the rows on screen
		// rather than some older branch further up the same column.
		let found: { label: string; colorIndex: number } | undefined;
		for (let row = visibleStart - 1; row >= lane.minRow; row--) {
			const node = nodeByRow.get(row);
			if (!node || node.x !== lane.column) continue;
			// A stash or the WIP row names a state, not a line of history.
			if (node.isStash || node.isWip) continue;

			const commit = commits[row];
			if (!commit || commit.refs.length === 0) continue;

			const primary = sortRefs(commit.refs)[0];
			found = { label: primary.short_name, colorIndex: node.colorIndex };
			break;
		}

		if (!found) continue;

		seen.add(lane.column);
		labels.push({
			column: lane.column,
			label: found.label,
			colorIndex: found.colorIndex,
		});
	}

	return labels;
}
