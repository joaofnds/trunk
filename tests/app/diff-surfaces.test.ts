import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** Two committed files, each carrying its own uncommitted edit, so the staged
 *  and unstaged surfaces show different content the moment one is staged. */
/** A hard-wrapped paragraph whose first sentence is deleted, reflowing the
 *  lines after it — the dotfiles baccec9 repro. Word emphasis must mark the
 *  removed sentence and nothing else. */
const REFLOWED_PARAGRAPH: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "core.md",
			content:
				"- On conflict, the more specific rule governs. The repo's own AGENTS.md or CLAUDE.md\n" +
				"  wins over this skill. A language file wins over this core file. The doctrine holds\n" +
				"  the reasons at principle level and wins where this skill seems to differ from it.\n",
		},
		{ step: "commit", message: "base" },
		{
			step: "file",
			path: "core.md",
			content:
				"- On conflict, the more specific rule governs. A language file wins over this core\n" +
				"  file. The doctrine holds the reasons at principle level and wins where this skill\n" +
				"  seems to differ from it.\n",
		},
	],
};

/** doc-44's "ts: rename a file and edit one line": a file moved to a new path
 *  with a single line changed. git reports one renamed entry at ~80%
 *  similarity; without rename detection it reads as a full delete plus a full
 *  add, and reviewing it means re-reading the whole file. */
const RENAMED_WITH_ONE_EDIT: RepoSpec = (() => {
	const original = Array.from(
		{ length: 20 },
		(_, at) => `export const value${at + 1} = ${at + 1};`,
	).join("\n");

	return {
		steps: [
			{ step: "file", path: "src/util.ts", content: `${original}\n` },
			{ step: "commit", message: "add util" },
			{ step: "removeFile", path: "src/util.ts" },
			{
				step: "file",
				path: "src/math-util.ts",
				content: `${original.replace(
					"export const value7 = 7;",
					"export const value7 = 7 + offset;",
				)}\n`,
			},
			{ step: "commit", message: "rename a file and edit one line" },
		],
	};
})();

const TWO_EDITED_FILES: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a\n" },
		{ step: "file", path: "b.txt", content: "b\n" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "a.txt", content: "a\nalpha\n" },
		{ step: "file", path: "b.txt", content: "b\nbeta\n" },
	],
};

describe("the diff surfaces", () => {
	afterEach(teardown);

	it("shows the working-tree edit unstaged and, once staged, the staged side", async () => {
		const app = await setup({ repo: TWO_EDITED_FILES });
		await app.repo.open();
		await app.staging.open();

		await app.staging.openFile("b.txt");

		await expect(
			waitFor("the unstaged diff of b.txt", () => {
				const lines = app.staging.addedLines();
				return lines.length > 0 ? lines : null;
			}),
		).resolves.toEqual(["beta"]);

		await app.staging.stageFile("a.txt");
		await app.staging.openStagedFile("a.txt");

		await expect(
			waitFor("the staged diff of a.txt", () => {
				const lines = app.staging.addedLines();
				return lines[0] === "alpha" ? lines : null;
			}),
		).resolves.toEqual(["alpha"]);
	});

	it("emphasizes only the removed sentence when a deletion reflows a paragraph", async () => {
		const app = await setup({ repo: REFLOWED_PARAGRAPH });
		await app.repo.open();
		await app.staging.open();

		await app.staging.openFile("core.md");
		await waitFor("the core.md diff", () => {
			const lines = app.staging.removedLines();
			return lines.length > 0 ? lines : null;
		});

		const removedWords = app.staging
			.emphasizedRemoved()
			.join(" ")
			.split(/\s+/)
			.filter(Boolean)
			.join(" ");
		expect(removedWords).toBe(
			"The repo's own AGENTS.md or CLAUDE.md wins over this skill.",
		);
		expect(app.staging.emphasizedAdded()).toEqual([]);
	});

	it("lists a renamed file once, naming both paths, and diffs only the changed line", async () => {
		const app = await setup({ repo: RENAMED_WITH_ONE_EDIT });
		await app.repo.open();

		await app.repo.selectCommit("rename a file and edit one line");

		await expect(
			waitFor("the commit's file list", () => {
				const files = app.repo.commitFiles();
				return files.length > 0 ? files : null;
			}),
		).resolves.toEqual(["R src/util.ts → src/math-util.ts"]);

		await app.repo.openCommitFile("math-util.ts");

		await expect(
			waitFor("the renamed file's diff", () => {
				const added = app.staging.addedLines();
				return added.length > 0 ? added : null;
			}),
		).resolves.toEqual(["export const value7 = 7 + offset;"]);
		expect(app.staging.removedLines()).toEqual(["export const value7 = 7;"]);
	});
});
