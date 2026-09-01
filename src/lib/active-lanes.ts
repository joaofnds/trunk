import type {
	GraphCommit,
	OverlayConnection,
	OverlayGraphData,
	OverlayNode,
} from "./types.js";

export function buildGraphData(
	commits: GraphCommit[],
	maxColumns: number,
): OverlayGraphData {
	const nodes: OverlayNode[] = [];
	const connections: OverlayConnection[] = [];

	// --- Stage 1: Build nodes ---
	for (let y = 0; y < commits.length; y++) {
		const commit = commits[y];
		nodes.push({
			oid: commit.oid,
			x: commit.column,
			y,
			colorIndex: commit.color_index,
			isMerge: commit.oid === "__wip__" ? false : commit.is_merge,
			isBranchTip: commit.oid === "__wip__" ? false : commit.is_branch_tip,
			isStash: commit.oid === "__wip__" ? false : commit.is_stash,
			isWip: commit.oid === "__wip__",
		});
	}

	// --- Build OID→Node map ---
	const nodeByOid = new Map<string, OverlayNode>();
	for (const node of nodes) {
		nodeByOid.set(node.oid, node);
	}

	// --- Stage 2: Build connections ---
	for (let y = 0; y < commits.length; y++) {
		const commit = commits[y];

		// --- WIP sentinel ---
		if (commit.oid === "__wip__") {
			// Anchor on the topmost head-chain row — exists even when HEAD is
			// detached (mid-rebase), unlike is_head. No anchor → no line.
			let headRow = -1;
			for (let r = y + 1; r < commits.length; r++) {
				if (commits[r].in_head_chain) {
					headRow = r;
					break;
				}
			}

			// Dashed connections from WIP to HEAD, split around every row already
			// occupying the WIP column, so the dashes never cross a commit dot.
			// Two shapes land here, both only in an unsettled frame: a stash still
			// inline, and the unpulled commits of a branch behind its upstream. On a
			// clean->dirty edit get_dirty_counts resolves ~40ms before
			// refresh_commit_graph (RepoView dispatches loadDirtyCounts synchronously
			// while the graph fetch waits a microtask for CommitGraph's $effect), so the
			// WIP row is drawn over the previous clean layout, where both still hold this
			// column. Structural ordering, not a race — the window grows with history
			// size.
			if (headRow > y) {
				const wipCol = commit.column;
				const breakRows: number[] = [];
				for (let r = y + 1; r < headRow; r++) {
					if (commits[r].column === wipCol) {
						breakRows.push(r);
					}
				}

				if (breakRows.length === 0) {
					connections.push({
						childX: wipCol,
						childY: y,
						parentX: wipCol,
						parentY: headRow,
						colorIndex: commit.color_index,
						dashed: true,
					});
				} else {
					const breakpoints = [y, ...breakRows, headRow];
					for (let i = 0; i < breakpoints.length - 1; i++) {
						connections.push({
							childX: wipCol,
							childY: breakpoints[i],
							parentX: wipCol,
							parentY: breakpoints[i + 1],
							colorIndex: commit.color_index,
							dashed: true,
						});
					}
				}
			}

			continue; // Skip normal connection processing
		}

		// --- Per-parent connections ---
		for (const parentOid of commit.parent_oids) {
			const parentNode = nodeByOid.get(parentOid);

			// The parent is real but sits beyond the loaded page. Placement already
			// decided this commit holds its column all the way down to that parent —
			// the straight-through edge below says so — so the lane continues to the
			// last loaded row. Dropping it instead renders the commit as a dot with
			// nothing leaving it, which reads as history that starts nowhere
			// (TRUNK-87: a branch far behind its upstream, whose parent is hundreds
			// of rows down). Once the parent's page loads it becomes a node and the
			// branch below takes over, so no seam is left at the join.
			if (!parentNode) {
				const straightEdge = commit.edges.find(
					(e) =>
						e.from_column === commit.column && e.to_column === commit.column,
				);
				if (!straightEdge) continue;

				connections.push({
					childX: commit.column,
					childY: y,
					parentX: commit.column,
					parentY: commits.length - 1,
					colorIndex: straightEdge.color_index,
					dashed: commit.is_stash,
				});
				continue;
			}

			// Color selection:
			// Same-column: use the straight edge in the child's own column (lane color).
			// Cross-column merge: parent's color (the branch being merged in).
			// Cross-column fork: child's color (the new branch).
			const sameColumn = commit.column === parentNode.x;
			let colorIndex: number;
			if (sameColumn) {
				const straightEdge = commit.edges.find(
					(e) =>
						e.from_column === commit.column && e.to_column === commit.column,
				);
				colorIndex = straightEdge?.color_index ?? commit.color_index;
			} else if (commit.is_merge) {
				colorIndex = parentNode.colorIndex;
			} else {
				colorIndex = commit.color_index;
			}
			const dashed = commit.is_stash;

			connections.push({
				childX: commit.column,
				childY: y,
				parentX: parentNode.x,
				parentY: parentNode.y,
				colorIndex,
				dashed,
			});
		}
	}

	return { nodes, connections, maxColumns };
}
