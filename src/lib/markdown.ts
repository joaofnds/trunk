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

// The "before" side rev for a split diff: HEAD for the dirty tree/index, the
// commit's first parent for a commit diff (falling back to HEAD if unknown).
export function beforeRev(
	diffKind: "unstaged" | "staged" | "commit",
	parentOid: string | null,
): RevSpec {
	if (diffKind === "commit" && parentOid)
		return { type: "commit", oid: parentOid };
	return { type: "head" };
}

// One rendered-markdown word span, reserved for Layer-2 word-level highlighting.
// Mirrors the Rust `WordSpan`; typed but never read in Layer 1.
export interface WordSpan {
	start: number;
	end: number;
}

// One row of a block-level markdown diff, in document reading order. Mirrors the
// Rust `DiffRow` union (serde `kind` tag, camelCase fields). `changed` carries
// both sides' fragments plus reserved Layer-2 word-span slots (absent in Layer 1).
export type DiffRow =
	| { kind: "unchanged"; html: string; lines: number }
	| { kind: "added"; html: string }
	| { kind: "removed"; html: string }
	| {
			kind: "changed";
			beforeHtml: string;
			afterHtml: string;
			beforeWordSpans?: WordSpan[];
			afterWordSpans?: WordSpan[];
	  };

// Diff a markdown file between two revs, returning one aligned row per top-level
// block. The frontend projects every layout (inline/split × full/hunk) from this
// array without re-invoking Rust.
export function renderMarkdownDiff(
	repoPath: string,
	filePath: string,
	beforeRev: RevSpec,
	afterRev: RevSpec,
): Promise<DiffRow[]> {
	return safeInvoke<DiffRow[]>("render_markdown_diff", {
		repoPath,
		filePath,
		beforeRev,
		afterRev,
	});
}
