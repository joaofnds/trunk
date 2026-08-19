/**
 * Pure aggregation of review comments into per-commit and per-file counts,
 * derived once in the comments store and read by every surface (commit graph,
 * file lists, WIP row). Sourcing the badges from one set of maps is what keeps
 * the trace trustworthy: a graph row's total always equals the sum of its file
 * badges plus its notes, because every number comes from the same projection.
 *
 * No IPC, no Svelte runes, no mutation of inputs — deterministic over
 * hand-buildable `Thread` fixtures.
 */

import type { ReviewSnapshots, Thread } from "./types.js";

/**
 * The synthetic graph row for uncommitted code has oid "__wip__" — not a
 * snapshot OID. Comments on uncommitted code anchor to the working-tree/index
 * snapshot OIDs, which are not graph rows, so their counts are folded under
 * this bucket so the WIP row can show them.
 */
export const WIP_OID = "__wip__";

export interface CommentCounts {
	byCommit: Map<string, number>;
	byFile: Map<string, number>;
}

/** The commit a comment is located through: a line comment's anchor, or a
 *  note's own commit_oid. "" for a note with no commit (never keyed into a map). */
export function commitOidForComment(c: Thread): string {
	if (c.anchor !== null) return c.anchor.commit_oid;
	return c.commit_oid ?? "";
}

/** byFile key: a file path can't contain NUL, so it's an unambiguous separator. */
export function fileCountKey(commitOid: string, filePath: string): string {
	return `${commitOid}\0${filePath}`;
}

export function buildCommentCounts(
	comments: Thread[],
	snapshots: ReviewSnapshots,
): CommentCounts {
	const byCommit = new Map<string, number>();
	const byFile = new Map<string, number>();

	const snapshotOids = new Set(
		[snapshots.working_tree_snapshot, snapshots.index_snapshot].filter(
			(oid): oid is string => oid !== null,
		),
	);

	for (const c of comments) {
		const oid = commitOidForComment(c);
		if (oid) {
			byCommit.set(oid, (byCommit.get(oid) ?? 0) + 1);
			if (snapshotOids.has(oid)) {
				byCommit.set(WIP_OID, (byCommit.get(WIP_OID) ?? 0) + 1);
			}
		}

		// Notes (anchor null) are excluded from byFile so a graph total never
		// double-counts: Graph(commit) = Σ(file badges) + (notes).
		if (c.anchor !== null) {
			const key = fileCountKey(c.anchor.commit_oid, c.anchor.file_path);
			byFile.set(key, (byFile.get(key) ?? 0) + 1);
		}
	}

	return { byCommit, byFile };
}

/** Slice byFile down to a `path → count` map for one OID. A generic file-list
 *  widget stays OID-agnostic: its parent resolves the section's OID and passes
 *  the slice down. Null OID (no snapshot / unresolved view) → empty map. */
export function fileCountsForOid(
	byFile: Map<string, number>,
	oid: string | null,
): Map<string, number> {
	const result = new Map<string, number>();
	if (oid === null) return result;

	const prefix = `${oid}\0`;
	for (const [key, count] of byFile) {
		if (key.startsWith(prefix)) {
			result.set(key.slice(prefix.length), count);
		}
	}
	return result;
}
