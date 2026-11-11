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
 * thread carries no OID at all.
 */

import type {
	DiffHunk,
	DiffLine,
	ReviewSnapshots,
	Side,
	Thread,
} from "./types.js";

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
export function rangeOn(
	thread: Thread,
	side: Side,
): { start: number; end: number } | null {
	// A thread about the whole file marks no line. It sits above the file
	// instead (threadsOnWholeFile).
	if (thread.whole_file) return null;
	if (thread.anchor !== null) {
		if (thread.anchor.side !== side) return null;

		return { start: thread.anchor.start_line, end: thread.anchor.end_line };
	}

	// Loose equality on purpose: the wire declares both of these optional as
	// well as nullable, so an absent field arrives as undefined and a strict
	// `!== null` would let it through as a range.
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

/** The threads about the whole of `filePath`, which sit above its first line. */
export function threadsOnWholeFile(
	viewComments: Thread[],
	filePath: string,
): Thread[] {
	return viewComments.filter(
		(c) =>
			c.whole_file &&
			(c.anchor?.file_path ?? c.content_pin?.file_path) === filePath,
	);
}

/** The threads whose range opens on this line, which the gutter marker counts. */
export function threadsStartingOn(
	viewComments: Thread[],
	side: Side,
	lineno: number | null | undefined,
): Thread[] {
	if (lineno === null || lineno === undefined) return [];

	return viewComments.filter((c) => rangeOn(c, side)?.start === lineno);
}

/**
 * The threads whose last line no line of `hunks` shows, sorted into the gaps
 * between them in line order: slot k holds those whose line comes before hunk
 * k, and the slot past the last hunk holds the rest. A hunk with no line on a
 * thread's side does not bound it.
 */
export function threadsBetweenHunks(
	viewComments: Thread[],
	hunks: DiffHunk[],
): Thread[][] {
	const placed: { thread: Thread; end: number; gap: number }[] = [];

	for (const thread of viewComments) {
		const side = thread.anchor?.side ?? "New";
		const end = rangeOn(thread, side)?.end;
		if (end === undefined || hunksShow(hunks, side, end)) continue;

		const next = hunks.findIndex((hunk) => {
			const first = firstNumberOn(hunk, side);
			return first !== null && first > end;
		});

		placed.push({ thread, end, gap: next === -1 ? hunks.length : next });
	}

	const gaps: Thread[][] = Array.from({ length: hunks.length + 1 }, () => []);
	for (const { thread, gap } of placed.sort((a, b) => a.end - b.end)) {
		gaps[gap].push(thread);
	}

	return gaps;
}

function hunksShow(hunks: DiffHunk[], side: Side, lineno: number): boolean {
	return hunks.some((hunk) =>
		hunk.lines.some((line) => numberOn(line, side) === lineno),
	);
}

function firstNumberOn(hunk: DiffHunk, side: Side): number | null {
	for (const line of hunk.lines) {
		const lineno = numberOn(line, side);
		if (lineno !== null) return lineno;
	}

	return null;
}

function numberOn(line: DiffLine, side: Side): number | null {
	return side === "Old" ? line.old_lineno : line.new_lineno;
}
