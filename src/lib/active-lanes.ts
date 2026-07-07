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

			// Dashed connections from WIP to HEAD, split around stash rows
			if (headRow > y) {
				const wipCol = commit.column;
				const stashRows: number[] = [];
				for (let r = y + 1; r < headRow; r++) {
					if (commits[r].is_stash && commits[r].column === wipCol) {
						stashRows.push(r);
					}
				}

				if (stashRows.length === 0) {
					connections.push({
						childX: wipCol,
						childY: y,
						parentX: wipCol,
						parentY: headRow,
						colorIndex: commit.color_index,
						dashed: true,
					});
				} else {
					const breakpoints = [y, ...stashRows, headRow];
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
			if (!parentNode) continue; // parent not loaded (pagination)

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
