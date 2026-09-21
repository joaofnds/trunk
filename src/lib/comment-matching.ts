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

/**
 * The inclusive line range a thread occupies on one side, or null when it does
 * not sit on that side at all.
 *
 * A pinned thread answers for "New" only. A current-file diff gives every line
 * the same number on both sides, so a side-blind range would return the thread
 * twice for one line and hand two rows the same key.
 */
function rangeOn(
	thread: Thread,
	side: Side,
): { start: number; end: number } | null {
	if (thread.anchor !== null) {
		if (thread.anchor.side !== side) return null;

		return { start: thread.anchor.start_line, end: thread.anchor.end_line };
	}

	const pin = thread.content_pin;
	const resolved = thread.resolved_start_line;
	if (side !== "New" || pin == null || resolved == null) return null;

	return { start: resolved, end: resolved + (pin.end_line - pin.start_line) };
}

/**
 * Which threads hang on this line. A multi-line thread hangs on its last line,
 * so its comment row sits below the whole block rather than inside it.
 */
export function commentsForLine(
	viewComments: Thread[],
	side: Side,
	lineno: number | null | undefined,
): Thread[] {
	if (lineno === null || lineno === undefined) return [];

	return viewComments.filter((c) => rangeOn(c, side)?.end === lineno);
}

/** Whether this line falls inside some thread's range. */
export function spannedByComment(
	viewComments: Thread[],
	side: Side,
	lineno: number | null | undefined,
): boolean {
	if (lineno === null || lineno === undefined) return false;

	return viewComments.some((c) => {
		const range = rangeOn(c, side);

		return range !== null && range.start <= lineno && lineno <= range.end;
	});
}
