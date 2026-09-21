/**
 * Pure matcher deciding which review comments belong to a given diff view and
 * line. No IPC, no Svelte runes, no mutation of inputs — every function is a
 * deterministic projection over hand-buildable `Comment` fixtures.
 *
 * Staging matching collapses to "anchor OID == current snapshot OID": the
 * session tracks only the current working-tree / index snapshot, and snapshots
 * are reused on an unchanged tree, so every live comment shares one OID per
 * side. A comment anchored to a superseded snapshot resolves to null OID here
 * and falls to panel-only by design.
 *
 * A current-file view matches on the content pin's path instead, since a pinned
 * thread carries no OID at all. That is a branch of its own rather than a
 * widening of `resolveViewOid`, whose null fall-through is what keeps every
 * other unhandled kind empty without anyone having to remember a gate.
 */

import type { ReviewSnapshots, Side, Thread } from "./types.js";

export type DiffKind =
	| "commit"
	| "unstaged"
	| "staged"
	| "conflicted"
	| "current_file";

/**
 * The kinds a DiffPanel actually renders. A conflicted file goes to MergeEditor
 * instead, so it never reaches the panel or anything below it.
 */
export type PanelDiffKind = Exclude<DiffKind, "conflicted">;

export interface ViewDescriptor {
	kind: DiffKind;
	commitOid: string | null;
	snapshots: ReviewSnapshots;
}

export function resolveViewOid(view: ViewDescriptor): string | null {
	if (view.kind === "commit") return view.commitOid;
	if (view.kind === "unstaged") return view.snapshots.working_tree_snapshot;
	if (view.kind === "staged") return view.snapshots.index_snapshot;
	return null;
}

export function commentsForView(
	comments: Thread[],
	view: ViewDescriptor,
	filePath: string,
): Thread[] {
	if (view.kind === "current_file") {
		return comments.filter(
			(c) =>
				c.content_pin?.file_path === filePath && c.resolved_start_line != null,
		);
	}

	const viewOid = resolveViewOid(view);
	if (viewOid === null) return [];

	return comments.filter(
		(c) =>
			c.anchor !== null &&
			c.anchor.commit_oid === viewOid &&
			c.anchor.file_path === filePath,
	);
}

export function commentsForLine(
	viewComments: Thread[],
	side: Side,
	lineno: number | null | undefined,
): Thread[] {
	if (lineno === null || lineno === undefined) return [];

	return viewComments.filter(
		(c) =>
			c.anchor !== null &&
			c.anchor.side === side &&
			c.anchor.end_line === lineno,
	);
}

export function spannedByComment(
	viewComments: Thread[],
	side: Side,
	lineno: number | null | undefined,
): boolean {
	if (lineno === null || lineno === undefined) return false;

	return viewComments.some(
		(c) =>
			c.anchor !== null &&
			c.anchor.side === side &&
			c.anchor.start_line <= lineno &&
			lineno <= c.anchor.end_line,
	);
}
