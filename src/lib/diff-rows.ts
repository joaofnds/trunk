/**
 * The diff views' row model: a pure projection of a diff into the flat,
 * heterogeneous row list a virtual list renders. No DOM, no runes — this is the
 * seat the exhaustive tests sit in, because a virtualized render under jsdom
 * reports a zero-height viewport and truncates silently.
 */

import { BAR_HEIGHT, UNIT } from "./chrome-heights.js";
import { commentsForLine, spannedByComment } from "./comment-matching.js";
import { type PairedRow, pairLines } from "./diff-utils.js";
import { displayColumns } from "./display-columns.js";
import { type RowMetrics, rowHeightFor } from "./row-metrics.js";
import type { ContentMode, DiffLine, FileDiff, Thread } from "./types.js";

export type DiffRow =
	| { kind: "file-header"; path: string; collapsed: boolean }
	| { kind: "binary"; path: string }
	| { kind: "hunk-header"; path: string; hunkIdx: number; header: string }
	| {
			kind: "line";
			path: string;
			hunkIdx: number;
			lineIdx: number;
			flatIdx: number;
			line: DiffLine;
			/** Display columns the content occupies, from the same pass. */
			columns: number;
			spanned: boolean;
	  }
	| {
			kind: "pair";
			path: string;
			hunkIdx: number;
			row: PairedRow;
			/** Display columns each side's content occupies, from the same pass. */
			leftColumns: number;
			rightColumns: number;
			spannedLeft: boolean;
			spannedRight: boolean;
	  }
	| {
			kind: "comment";
			path: string;
			hunkIdx: number;
			lineIdx: number;
			flatIdx: number;
			threads: Thread[];
	  };

/** One hunk's place in the rendered document. The sequence is an ordinal one,
 *  not a per-file index: `[` and `]` step through every hunk of every rendered
 *  file in order, so a hunk-indexed array would collide across files. */
export interface HunkNavEntry {
	path: string;
	hunkIdx: number;
	/** The hunk's header row in hunk mode, its first line row in full mode. */
	rowIndex: number;
}

export interface DiffRowModel {
	rows: DiffRow[];
	/** Every rendered hunk, in document order. */
	hunkNav: HunkNavEntry[];
	/** Digits of the largest line number, plus one. */
	gutterChars: number;
	/** Widest content per column, in display columns. */
	columns: number[];
}

export interface BuildOptions {
	content: ContentMode;
	comments: Thread[];
	showInlineComments: boolean;
	collapsed: Set<string>;
	/** Whether the view shows a per-file header bar, as the multi-file views do. */
	fileHeaders: boolean;
	tabSize: number;
	invisibles: boolean;
}

/** Heights the fixed row shapes declare rather than discover. Each row's own
 *  CSS sets its height from the matching custom property below, so the height
 *  function and the rendered row cannot disagree: a toolbar change that alters
 *  a row's height has to change this number. */
export const FIXED_ROW_HEIGHTS = {
	fileHeader: BAR_HEIGHT,
	hunkHeader: BAR_HEIGHT,
	binary: 8 * UNIT,
} as const;

/** The custom properties the rows read, declared from the same numbers. */
export const FIXED_ROW_HEIGHT_VARS = [
	`--diff-file-header-height: ${FIXED_ROW_HEIGHTS.fileHeader}px`,
	`--diff-hunk-header-height: ${FIXED_ROW_HEIGHTS.hunkHeader}px`,
	`--diff-binary-row-height: ${FIXED_ROW_HEIGHTS.binary}px`,
].join("; ");

/** Total diff lines across files — the `lines` attribute every view's
 *  `diff.buildRows` observation reports. */
export function countLines(diffs: FileDiff[]): number {
	let total = 0;
	for (const fd of diffs) {
		for (const hunk of fd.hunks) total += hunk.lines.length;
	}
	return total;
}

export function buildInlineRows(
	fileDiffs: FileDiff[],
	opts: BuildOptions,
): DiffRowModel {
	const rows: DiffRow[] = [];
	const hunkNav: HunkNavEntry[] = [];
	let widest = 0;
	let maxLineNumber = 0;

	for (const fd of fileDiffs) {
		const collapsed = opts.collapsed.has(fd.path);

		if (opts.fileHeaders) {
			rows.push({ kind: "file-header", path: fd.path, collapsed });
		}
		if (collapsed) continue;

		if (fd.is_binary) {
			rows.push({ kind: "binary", path: fd.path });
			continue;
		}

		let flatIdx = 0;

		for (const [hunkIdx, hunk] of fd.hunks.entries()) {
			hunkNav.push({ path: fd.path, hunkIdx, rowIndex: rows.length });

			if (opts.content === "hunk") {
				rows.push({
					kind: "hunk-header",
					path: fd.path,
					hunkIdx,
					header: hunk.header,
				});
			}

			for (const [lineIdx, line] of hunk.lines.entries()) {
				const columns = displayColumns(
					line.content,
					opts.tabSize,
					opts.invisibles,
				);

				widest = Math.max(widest, columns);
				maxLineNumber = Math.max(
					maxLineNumber,
					line.old_lineno ?? 0,
					line.new_lineno ?? 0,
				);

				rows.push({
					kind: "line",
					path: fd.path,
					hunkIdx,
					lineIdx,
					flatIdx,
					line,
					columns,
					spanned: opts.showInlineComments && isSpanned(line, opts.comments),
				});

				const threads = opts.showInlineComments
					? threadsOn(line, opts.comments)
					: [];
				if (threads.length > 0) {
					rows.push({
						kind: "comment",
						path: fd.path,
						hunkIdx,
						lineIdx,
						flatIdx,
						threads,
					});
				}

				flatIdx++;
			}
		}
	}

	return {
		rows,
		hunkNav,
		gutterChars: String(maxLineNumber).length + 1,
		columns: [widest],
	};
}

/** The split view's model: one row per paired line rather than one per line.
 *  It pairs within each hunk, as `buildInlineRows` iterates them, so a pair row
 *  reports the hunk index its gutter callbacks need. */
export function buildSplitRows(
	fileDiffs: FileDiff[],
	opts: BuildOptions,
): DiffRowModel {
	const rows: DiffRow[] = [];
	const hunkNav: HunkNavEntry[] = [];
	let widestLeft = 0;
	let widestRight = 0;
	let maxLineNumber = 0;

	const columnsOf = (line: DiffLine): number =>
		displayColumns(line.content, opts.tabSize, opts.invisibles);

	for (const fd of fileDiffs) {
		const collapsed = opts.collapsed.has(fd.path);

		if (opts.fileHeaders) {
			rows.push({ kind: "file-header", path: fd.path, collapsed });
		}
		if (collapsed) continue;

		if (fd.is_binary) {
			rows.push({ kind: "binary", path: fd.path });
			continue;
		}

		let flatBase = 0;

		for (const [hunkIdx, hunk] of fd.hunks.entries()) {
			hunkNav.push({ path: fd.path, hunkIdx, rowIndex: rows.length });

			if (opts.content === "hunk") {
				rows.push({
					kind: "hunk-header",
					path: fd.path,
					hunkIdx,
					header: hunk.header,
				});
			}

			for (const line of hunk.lines) {
				maxLineNumber = Math.max(
					maxLineNumber,
					line.old_lineno ?? 0,
					line.new_lineno ?? 0,
				);
			}

			for (const pair of pairLines(hunk.lines)) {
				const leftColumns = pair.left ? columnsOf(pair.left.line) : 0;
				const rightColumns = pair.right ? columnsOf(pair.right.line) : 0;

				widestLeft = Math.max(widestLeft, leftColumns);
				widestRight = Math.max(widestRight, rightColumns);

				rows.push({
					kind: "pair",
					path: fd.path,
					hunkIdx,
					row: pair,
					leftColumns,
					rightColumns,
					spannedLeft:
						opts.showInlineComments &&
						pair.left !== null &&
						spannedByComment(opts.comments, "Old", pair.left.line.old_lineno),
					spannedRight:
						opts.showInlineComments &&
						pair.right !== null &&
						spannedByComment(opts.comments, "New", pair.right.line.new_lineno),
				});

				const threads = opts.showInlineComments
					? pairThreads(pair, opts.comments)
					: [];
				if (threads.length > 0) {
					// The right side anchors the row where it exists: it is the side
					// the gutter arms selection from, and the one a New-side comment
					// resolves against. A phantom right leaves the left side.
					const anchor = pair.right ?? pair.left;
					if (anchor) {
						rows.push({
							kind: "comment",
							path: fd.path,
							hunkIdx,
							lineIdx: anchor.lineIdx,
							flatIdx: flatBase + anchor.lineIdx,
							threads,
						});
					}
				}
			}

			flatBase += hunk.lines.length;
		}
	}

	return {
		rows,
		hunkNav,
		gutterChars: String(maxLineNumber).length + 1,
		columns: [widestLeft, widestRight],
	};
}

/** The row rendering one line of one hunk, or -1 when the model carries no such
 *  row — a collapsed file has none. The scan starts at the hunk and stops at the
 *  line, so it costs the hunk's length rather than the file's: a per-line lookup
 *  table would be rebuilt on every stage and unstage, which is the surface's
 *  primary gesture, to save one lookup per keypress. */
export function rowIndexForLine(
	model: DiffRowModel,
	path: string,
	hunkIdx: number,
	lineIdx: number,
): number {
	const nav = model.hunkNav.find(
		(entry) => entry.path === path && entry.hunkIdx === hunkIdx,
	);
	if (!nav) return -1;

	for (let index = nav.rowIndex; index < model.rows.length; index++) {
		const row = model.rows[index];
		if (row.kind === "file-header" || row.kind === "binary") break;
		if (row.path !== path || row.hunkIdx !== hunkIdx) break;
		if (row.kind === "line" && row.lineIdx === lineIdx) return index;
		// A Context line sits on both sides under the same index, so either match
		// names the same row.
		if (
			row.kind === "pair" &&
			(row.row.left?.lineIdx === lineIdx || row.row.right?.lineIdx === lineIdx)
		) {
			return index;
		}
	}

	return -1;
}

function pairThreads(pair: PairedRow, comments: Thread[]): Thread[] {
	return [
		...commentsForLine(comments, "New", pair.right?.line.new_lineno ?? null),
		...commentsForLine(comments, "Old", pair.left?.line.old_lineno ?? null),
	];
}

function threadsOn(line: DiffLine, comments: Thread[]): Thread[] {
	return [
		...commentsForLine(comments, "New", line.new_lineno),
		...commentsForLine(comments, "Old", line.old_lineno),
	];
}

function isSpanned(line: DiffLine, comments: Thread[]): boolean {
	return (
		spannedByComment(comments, "New", line.new_lineno) ||
		spannedByComment(comments, "Old", line.old_lineno)
	);
}

/** One exact height per row, in row order. Nothing here measures: a line's
 *  height comes from its column count, a comment row's from the heights the
 *  view probed before it rendered the list. A row with neither refuses rather
 *  than substituting a default, which is what makes the offsets a prefix sum
 *  the list never has to correct. */
export function rowHeights(
	model: DiffRowModel,
	metrics: RowMetrics,
	availableColumns: number,
	wrap: boolean,
	probed: Map<string, number>,
): number[] {
	return model.rows.map((row) =>
		heightOf(row, metrics, availableColumns, wrap, probed),
	);
}

function heightOf(
	row: DiffRow,
	metrics: RowMetrics,
	availableColumns: number,
	wrap: boolean,
	probed: Map<string, number>,
): number {
	if (row.kind === "line") {
		if (!wrap) return metrics.lineHeightPx;
		return rowHeightFor(row.columns, availableColumns, metrics);
	}

	if (row.kind === "pair") {
		if (!wrap) return metrics.lineHeightPx;

		// The taller side sets the row: a max of two heights that never
		// under-predict cannot under-predict either.
		return Math.max(
			rowHeightFor(row.leftColumns, availableColumns, metrics),
			rowHeightFor(row.rightColumns, availableColumns, metrics),
		);
	}

	if (row.kind === "comment") {
		return row.threads.reduce(
			(total, thread) => total + probedHeight(probed, thread.id),
			0,
		);
	}

	if (row.kind === "file-header") return FIXED_ROW_HEIGHTS.fileHeader;
	if (row.kind === "hunk-header") return FIXED_ROW_HEIGHTS.hunkHeader;

	return FIXED_ROW_HEIGHTS.binary;
}

function probedHeight(probed: Map<string, number>, threadId: string): number {
	const height = probed.get(threadId);
	if (height === undefined) {
		throw new Error(`comment thread ${threadId} was never probed`);
	}

	return height;
}
