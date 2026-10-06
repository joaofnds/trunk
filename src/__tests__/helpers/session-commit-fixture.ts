import type { SessionCommit } from "../../lib/types.js";

/**
 * A commit the graph does not draw, so a test states only what it is about:
 * the lane it sits on, its age, or that the repository has lost it.
 */
export function aSessionCommit(
	overrides: Partial<SessionCommit> & Pick<SessionCommit, "oid">,
): SessionCommit {
	return {
		short_oid: overrides.oid.slice(0, 7),
		summary: "",
		is_snapshot: false,
		lane_ref: null,
		color_index: null,
		author_timestamp: null,
		exists: true,
		picked: true,
		...overrides,
	};
}
