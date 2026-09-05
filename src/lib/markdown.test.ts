import { describe, expect, it, vi } from "vitest";
import {
	afterRev,
	beforeRev,
	isMarkdownPath,
	renderMarkdownDiff,
} from "./markdown.js";

const safeInvoke = vi.fn();
vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: (cmd: string, args: Record<string, unknown>) =>
		safeInvoke(cmd, args),
}));

describe("isMarkdownPath", () => {
	it("detects the four allowed markdown extensions, case-insensitively", () => {
		for (const p of [
			"README.md",
			"docs/GUIDE.MARKDOWN",
			"notes.mdown",
			"x.mkd",
			"Deep/Path.Md",
		]) {
			expect(isMarkdownPath(p)).toBe(true);
		}
	});

	it("excludes .mdx and non-markdown files", () => {
		for (const p of [
			"Component.mdx",
			"main.rs",
			"styles.css",
			"noext",
			"a.md.ts",
		]) {
			expect(isMarkdownPath(p)).toBe(false);
		}
	});
});

describe("rev derivation", () => {
	it("maps each diff kind to its after-side rev", () => {
		expect(afterRev("unstaged", "abc")).toEqual({ type: "workingTree" });
		expect(afterRev("staged", "abc")).toEqual({ type: "index" });
		expect(afterRev("commit", "abc")).toEqual({ type: "commit", oid: "abc" });
	});

	it("maps the before side per kind: index for unstaged, HEAD for staged, parent for commit", () => {
		expect(beforeRev("unstaged", null)).toEqual({ type: "index" });
		expect(beforeRev("staged", null)).toEqual({ type: "head" });
		expect(beforeRev("commit", "parent1")).toEqual({
			type: "commit",
			oid: "parent1",
		});
	});

	it("maps a parentless (root) commit's before side to the empty rev", () => {
		expect(beforeRev("commit", null)).toEqual({ type: "empty" });
	});
});

describe("renderMarkdownDiff", () => {
	it("invokes render_markdown_diff with both revs and the whitespace flag", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const before = beforeRev("unstaged", null);
		const after = afterRev("unstaged", "");
		renderMarkdownDiff("/repo", "README.md", null, before, after, true);
		expect(safeInvoke).toHaveBeenCalledWith("render_markdown_diff", {
			repoPath: "/repo",
			filePath: "README.md",
			oldPath: null,
			beforeRev: before,
			afterRev: after,
			ignoreWhitespace: true,
		});
	});

	it("sends a renamed file's old path so the before side is read from it", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const before = beforeRev("commit", "p");
		const after = afterRev("commit", "c");
		renderMarkdownDiff(
			"/repo",
			"docs/new.md",
			"docs/old.md",
			before,
			after,
			false,
		);
		expect(safeInvoke).toHaveBeenCalledWith(
			"render_markdown_diff",
			expect.objectContaining({
				filePath: "docs/new.md",
				oldPath: "docs/old.md",
			}),
		);
	});
});
