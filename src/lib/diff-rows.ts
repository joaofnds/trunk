/**
 * The diff views' row model: a pure projection of a diff into the flat,
 * heterogeneous row list a virtual list renders. No DOM, no runes — this is the
 * seat the exhaustive tests sit in, because a virtualized render under jsdom
 * reports a zero-height viewport and truncates silently.
 */

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
			spanned: boolean;
	  }
	| {
			kind: "comment";
			path: string;
			hunkIdx: number;
			lineIdx: number;
			flatIdx: number;
			threads: Thread[];
	  };

export interface DiffRowModel {
	rows: DiffRow[];
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

export function buildInlineRows(
	fileDiffs: FileDiff[],
	opts: BuildOptions,
): DiffRowModel {
	const rows: DiffRow[] = [];

	for (const fd of fileDiffs) {
		let flatIdx = 0;

		for (const [hunkIdx, hunk] of fd.hunks.entries()) {
			if (opts.content === "hunk") {
				rows.push({
					kind: "hunk-header",
					path: fd.path,
					hunkIdx,
					header: hunk.header,
				});
			}

			for (const [lineIdx, line] of hunk.lines.entries()) {
				rows.push({
					kind: "line",
					path: fd.path,
					hunkIdx,
					lineIdx,
					flatIdx,
					line,
					spanned: false,
				});
				flatIdx++;
			}
		}
	}

	return { rows, gutterChars: 0, columns: [] };
}
