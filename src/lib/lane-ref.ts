import { sortRefs } from "./ref-pill-data.js";
import type { GraphCommit, RefLabel } from "./types.js";

/**
 * The ref that names the lane a row sits in: the nearest one at or above the row
 * in its own column.
 *
 * A commit is usually reachable from several branches, and asking which ones is a
 * walk of the whole graph. The lane is the cheap and honest answer: placement has
 * already put this commit on one line of history and coloured it accordingly, so
 * the ref at the top of that lane is the name the colour is already implying.
 *
 * Where a row carries more than one ref, `sortRefs` picks the same primary the ref
 * pill shows, so hovering and reading the pill agree.
 *
 * A stash names a state rather than a line of history, so it never names a lane.
 */
export function laneRefForRow(
	commits: GraphCommit[],
	row: number,
): RefLabel | undefined {
	const hovered = commits[row];
	if (!hovered) return undefined;

	for (let r = row; r >= 0; r--) {
		const commit = commits[r];
		if (!commit || commit.column !== hovered.column) continue;
		if (commit.is_stash) continue;
		if (commit.refs.length === 0) continue;

		return sortRefs(commit.refs)[0];
	}

	return undefined;
}
