import { safeInvoke } from "./invoke.js";
import type { FileDiff } from "./types.js";

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

export function renderMarkdown(
	repoPath: string,
	filePath: string,
	rev: RevSpec,
): Promise<string> {
	return safeInvoke<string>("render_markdown", { repoPath, filePath, rev });
}

export function renderMarkdownText(
	repoPath: string,
	filePath: string,
	rev: RevSpec,
	text: string,
): Promise<string> {
	return safeInvoke<string>("render_markdown_text", {
		repoPath,
		filePath,
		rev,
		text,
	});
}

// Reconstruct the markdown text of the changed hunks for one side of the diff:
// "after" keeps context + added lines, "before" keeps context + deleted lines.
// Line contents already carry their trailing newlines; hunks are separated by a
// blank line so non-contiguous regions don't merge into one block. Used for
// hunk-scoped rendered markdown (render only what changed, not the whole file).
export function hunkMarkdown(
	fileDiff: FileDiff,
	side: "before" | "after",
): string {
	const keep =
		side === "after"
			? (o: string) => o === "Context" || o === "Add"
			: (o: string) => o === "Context" || o === "Delete";
	return fileDiff.hunks
		.map((h) =>
			h.lines
				.filter((l) => keep(l.origin))
				.map((l) => l.content)
				.join(""),
		)
		.filter((t) => t.length > 0)
		.join("\n");
}
