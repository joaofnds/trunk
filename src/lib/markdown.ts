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
export function beforeRev(
	diffKind: "unstaged" | "staged" | "commit",
	parentOid: string | null,
): RevSpec {
	switch (diffKind) {
		case "unstaged":
			return { type: "index" };
		case "staged":
			return { type: "head" };
		case "commit":
			return parentOid ? { type: "commit", oid: parentOid } : { type: "empty" };
	}
}

// One row of a block-level markdown diff, in document reading order. Mirrors the
// Rust `DiffRow` union (serde `kind` tag, camelCase fields). `changed` always
// carries its before/after fragments (split columns / stacked inline fallback) and,
// for a single-leaf block that word-merges, an inline `wordHtml` with `md-word-*`
// del/ins marks (absent for containers, code blocks, and dense rewrites).
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
			wordHtml?: string;
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

// Diff a markdown file between two revs. The frontend projects every layout
// (inline/split × full/hunk) from the returned diff's rows without re-invoking
// Rust.
export function renderMarkdownDiff(
	repoPath: string,
	filePath: string,
	beforeRev: RevSpec,
	afterRev: RevSpec,
): Promise<MarkdownDiff> {
	return safeInvoke<MarkdownDiff>("render_markdown_diff", {
		repoPath,
		filePath,
		beforeRev,
		afterRev,
	});
}
