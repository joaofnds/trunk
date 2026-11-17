import type { GraphCommit } from "./types.js";

/** Whether the branch at `head` can fast-forward to `target`, which it can when
 *  `target` descends from `head` and is not `head` itself. The rows arrive newest
 *  first in topological order, so every commit on a path from `target` down to
 *  `head` sits between their two rows, and the walk never reads past `head`'s. */
export function canFastForward(
	commits: readonly GraphCommit[],
	{ head, target }: { head: string; target: string },
): boolean {
	const rowOf = new Map(commits.map((commit, row) => [commit.oid, row]));
	const headRow = rowOf.get(head);
	if (headRow === undefined || target === head) return false;

	const seen = new Set<string>();
	const pending = [target];
	for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
		if (oid === head) return true;
		const row = rowOf.get(oid);
		if (row === undefined || row >= headRow || seen.has(oid)) continue;
		seen.add(oid);
		pending.push(...commits[row].parent_oids);
	}
	return false;
}
