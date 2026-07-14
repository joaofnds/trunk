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

export function renderMarkdown(
	repoPath: string,
	filePath: string,
	rev: RevSpec,
): Promise<string> {
	return safeInvoke<string>("render_markdown", { repoPath, filePath, rev });
}
