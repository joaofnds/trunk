import { safeInvoke } from "./invoke.js";

// Extension-only markdown detection (grill §5). Case-insensitive; `.mdx` is
// deliberately excluded — it's JSX-in-markdown, which comrak won't render as
// plain GFM.
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);

export function isMarkdownPath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	return MARKDOWN_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// Mirrors the Rust `RevSpec` enum (serde tag "type", camelCase variants). Which
// version of a file to render.
export type RevSpec =
	| { type: "workingTree" }
	| { type: "index" }
	| { type: "head" }
	| { type: "empty" }
	| { type: "commit"; oid: string };

// The "after" side rev for an inline diff of the given kind.
export function afterRev(
	diffKind: "unstaged" | "staged" | "commit",
	commitOid: string,
): RevSpec {
	switch (diffKind) {
		case "unstaged":
			return { type: "workingTree" };
		case "staged":
			return { type: "index" };
		case "commit":
			return { type: "commit", oid: commitOid };
	}
}

// The "before" side rev for a split diff, mirroring Source's bases: unstaged is
// index→workdir, staged is HEAD→index, commit is first-parent→commit. A
// parentless (root) commit has no before side at all — the empty rev renders it
// as an all-added file.
//
// `compareBaseOid`, when given, overrides the commit case: a compare selection
// pairs renames across the whole base-to-target range (list_compare_files_inner
// in diff.rs), so the before side must read at that same base, not the
// target's first parent — otherwise a rename earlier in the range reads the
// old path at a rev where it's already gone (TRUNK-163).
export function beforeRev(
	diffKind: "unstaged" | "staged" | "commit",
	parentOid: string | null,
	compareBaseOid?: string | null,
): RevSpec {
	switch (diffKind) {
		case "unstaged":
			return { type: "index" };
		case "staged":
			return { type: "head" };
		case "commit": {
			const oid = compareBaseOid ?? parentOid;
			return oid ? { type: "commit", oid } : { type: "empty" };
		}
	}
}

// One row of a block-level markdown diff, in document reading order. Mirrors the
// Rust `DiffRow` union (serde `kind` tag, camelCase fields). `changed` always
// carries its before/after fragments (the split columns) and, when one can be
// built, a `mergedHtml`: ONE copy carrying `md-word-*` del/ins marks, which is
// what the inline view renders.
//
// Every row carries its 1-based inclusive source-line span on the AFTER axis so
// hunk context is budgeted by line distance, matching Source. `removed` has no
// after side: it carries its before span plus `afterAnchor` — the after-side
// line the deletion sits at — keeping all context math on one axis.
export type DiffRow =
	| { kind: "unchanged"; html: string; afterStart: number; afterEnd: number }
	| { kind: "added"; html: string; afterStart: number; afterEnd: number }
	| {
			kind: "removed";
			html: string;
			beforeStart: number;
			beforeEnd: number;
			afterAnchor: number;
	  }
	| {
			kind: "changed";
			beforeHtml: string;
			afterHtml: string;
			// The suggestion-mode fragment: ONE copy carrying del/ins marks and
			// red/green leaves together; absent when no merged copy could be
			// built and the merged view falls back to the before/after pair.
			mergedHtml?: string;
			// Whether the fragments already point at what changed. True lets the
			// renderer drop the block-level wash so the tinted leaf carries the
			// highlight alone; absent (false) means the row has nothing to point
			// at and must keep the wash, or it renders as two identical copies.
			hasTints?: boolean;
			// The hunk-mode copy of a changed CONTAINER (list, table): the merged
			// copy with unchanged leaves outside the context window dropped, so a
			// twenty-item list whose one item changed does not render whole.
			// Absent for single-leaf blocks and whenever nothing was folded — the
			// merged copy then serves both modes.
			// The two sides render to the same visible text. A rewrap changes the
			// source lines but not one rendered word, so the row has nothing to
			// tint and would draw as an untinted block the reader cannot tell
			// from an unchanged one. The view says so instead.
			rendersIdentically?: boolean;
			hunkMergedHtml?: string;
			// The same fold applied to the two split-column fragments. Absent
			// under the same conditions as `hunkMergedHtml`.
			hunkBeforeHtml?: string;
			hunkAfterHtml?: string;
			// How many leaves `hunkMergedHtml` dropped, for the "N items hidden"
			// note. Absent (0) whenever `hunkMergedHtml` is.
			hunkHiddenLeaves?: number;
			afterStart: number;
			afterEnd: number;
	  };

// Mirrors the Rust `MarkdownDiff` struct: the aligned rows plus whether the line
// diff found only changes the rendered view cannot represent (whitespace between
// blocks) — every row unchanged yet the sources differ.
export type MarkdownDiff = {
	rows: DiffRow[];
	whitespaceOnly: boolean;
};

// The file a rendered diff is of: its current path and, for a rename, the old
// path its before side is read by. Named so the two paths cannot be swapped at
// a call site.
export interface MarkdownDiffFile {
	path: string;
	oldPath: string | null;
}

// Diff a markdown file between two revs. The frontend projects every layout
// (inline/split × full/hunk) from the returned diff's rows without re-invoking
// Rust.
export function renderMarkdownDiff(
	repoPath: string,
	file: MarkdownDiffFile,
	beforeRev: RevSpec,
	afterRev: RevSpec,
	ignoreWhitespace: boolean,
): Promise<MarkdownDiff> {
	return safeInvoke<MarkdownDiff>("render_markdown_diff", {
		repoPath,
		filePath: file.path,
		oldPath: file.oldPath,
		beforeRev,
		afterRev,
		ignoreWhitespace,
	});
}
