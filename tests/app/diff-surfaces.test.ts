import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** Two committed files, each carrying its own uncommitted edit, so the staged
 *  and unstaged surfaces show different content the moment one is staged. */
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
});
