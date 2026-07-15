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

	it("maps the before side to HEAD, or the parent for a commit diff", () => {
		expect(beforeRev("unstaged", null)).toEqual({ type: "head" });
		expect(beforeRev("commit", "parent1")).toEqual({
			type: "commit",
			oid: "parent1",
		});
		expect(beforeRev("commit", null)).toEqual({ type: "head" });
	});
});

describe("renderMarkdownDiff", () => {
	it("invokes render_markdown_diff with both revs", () => {
		safeInvoke.mockResolvedValue([]);
		const before = beforeRev("unstaged", null);
		const after = afterRev("unstaged", "");
		renderMarkdownDiff("/repo", "README.md", before, after);
		expect(safeInvoke).toHaveBeenCalledWith("render_markdown_diff", {
			repoPath: "/repo",
			filePath: "README.md",
			beforeRev: before,
			afterRev: after,
		});
	});
});
