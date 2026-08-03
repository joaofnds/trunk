import type { EdgeType, GraphCommit } from "./types.js";

function makeWipItem(msg: string, col: number, colorIdx: number): GraphCommit {
	return {
		oid: "__wip__",
		short_oid: "",
		summary: msg,
		body: null,
		author_name: "",
		author_email: "",
		author_timestamp: 0,
		parent_oids: [],
		column: col,
		color_index: colorIdx,
		edges: [
			{
				from_column: col,
				to_column: col,
				edge_type: "Straight" as EdgeType,
				color_index: colorIdx,
				dashed: false,
			},
		],
		refs: [],
		is_head: false,
		is_merge: false,
		is_branch_tip: false,
		is_stash: false,
		in_head_chain: false,
	};
}

/**
 * The rows the graph renders: the loaded commits, with a WIP row prepended at
 * the head-chain column while the worktree is dirty.
 *
 * Stash rows arrive from the backend already carrying lane data, so this is the
 * only row the frontend synthesises. The anchor is `in_head_chain`, never
 * `is_head`: a detached HEAD (mid-rebase, or after checking out a sha) carries
 * no `is_head` row and the WIP row would land in lane 0, away from its own work.
 */
export function withWipRow(
	commits: GraphCommit[],
	wipCount: number,
	wipMessage: string,
): GraphCommit[] {
	if (wipCount <= 0) return [...commits];

	const headCommit = commits.find((c) => c.in_head_chain);

	return [
		makeWipItem(
			wipMessage,
			headCommit?.column ?? 0,
			headCommit?.color_index ?? 0,
		),
		...commits,
	];
}
