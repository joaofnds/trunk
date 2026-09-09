import { describe, expect, it } from "vitest";
import { rankFiles } from "./file-finder.js";
import type { TrackedFile } from "./types.js";

function tracked(path: string, changed = false): TrackedFile {
	return { path, changed };
}

function paths(files: TrackedFile[]): string[] {
	return files.map((f) => f.path);
}

describe("rankFiles", () => {
	it("ranks changed files before unchanged ones", () => {
		const files = [
			tracked("src/alpha.ts"),
			tracked("src/beta.ts", true),
			tracked("src/gamma.ts"),
		];

		expect(paths(rankFiles(files, ""))).toEqual([
			"src/beta.ts",
			"src/alpha.ts",
			"src/gamma.ts",
		]);
	});

	it("lists every tracked file when the query is empty", () => {
		const files = [tracked("a.ts"), tracked("b.ts")];

		expect(rankFiles(files, "")).toHaveLength(2);
	});

	it("keeps a file whose path contains the query's characters in order", () => {
		const files = [tracked("src/components/DiffPanel.svelte")];

		expect(paths(rankFiles(files, "dfpnl"))).toEqual([
			"src/components/DiffPanel.svelte",
		]);
	});

	it("drops a file whose path lacks the query's characters", () => {
		const files = [tracked("src/alpha.ts"), tracked("src/beta.ts")];

		expect(paths(rankFiles(files, "zzz"))).toEqual([]);
	});

	it("drops a file whose characters appear out of order", () => {
		const files = [tracked("abc.ts")];

		expect(rankFiles(files, "cba")).toEqual([]);
	});

	it("matches without regard to case", () => {
		const files = [tracked("src/RepoView.svelte")];

		expect(paths(rankFiles(files, "repoview"))).toEqual([
			"src/RepoView.svelte",
		]);
	});

	it("ranks a contiguous match above a scattered one", () => {
		const files = [
			tracked("s/o/m/e/t/h/i/n/g.ts"),
			tracked("src/something.ts"),
		];

		expect(paths(rankFiles(files, "something"))).toEqual([
			"src/something.ts",
			"s/o/m/e/t/h/i/n/g.ts",
		]);
	});

	it("ranks a filename match above a directory match", () => {
		const files = [tracked("panel/other.ts"), tracked("src/panel.ts")];

		expect(paths(rankFiles(files, "panel"))).toEqual([
			"src/panel.ts",
			"panel/other.ts",
		]);
	});

	it("ranks a changed file first even when an unchanged one matches better", () => {
		const files = [tracked("panel.ts"), tracked("a/b/c/p/n/l.ts", true)];

		expect(paths(rankFiles(files, "pnl"))[0]).toBe("a/b/c/p/n/l.ts");
	});

	it("breaks a tie by path so the order is stable", () => {
		const files = [tracked("b.ts"), tracked("a.ts")];

		expect(paths(rankFiles(files, ""))).toEqual(["a.ts", "b.ts"]);
	});

	it("ignores whitespace around the query", () => {
		const files = [tracked("src/alpha.ts")];

		expect(paths(rankFiles(files, "  alpha  "))).toEqual(["src/alpha.ts"]);
	});
});
