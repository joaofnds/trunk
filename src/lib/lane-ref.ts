import type { GraphCommit, RefLabel } from "./types.js";

/**
 * The ref naming the lane a row sits in: the one on the commit that opened that lane.
 *
 * The backend records which commit claimed each lane while it lays the graph out, and every
 * row below inherits that claim, so this is a read rather than a search. What it is not is
 * the nearest ref above the row: a column freed by one branch and taken by another, and a
 * tag pointing inside a branch's lane, are both nearer without naming the line of history
 * the row belongs to. Because the claim is resolved over the whole walk, a row still names
 * its lane when that lane's tip has not been paged in.
 *
 * A lane only a tag holds is named by that tag, which is what keeps a line whose branch was
 * deleted from going nameless.
 *
 * The WIP row has no lane of its own to name.
 */
export function laneRefForRow(
	commits: GraphCommit[],
	row: number,
): RefLabel | undefined {
	return commits[row]?.lane_ref ?? undefined;
}
