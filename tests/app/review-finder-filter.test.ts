import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const NEXT_FILE = "src/next.ts";
const NEXT_FILE_CONTENT = "export const next = true;";
const REPOSITORY: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "src/main.ts",
			content: "export const main = true;\n",
		},
		{ step: "file", path: NEXT_FILE, content: `${NEXT_FILE_CONTENT}\n` },
		{ step: "commit", message: "Add main" },
	],
};

describe("the review file finder while review threads are hidden", () => {
	afterEach(teardown);

	it("opens from the review panel", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		await app.review.hideThreads(() => true);
		await app.review.openPanel();

		await app.review.openFileFinder();

		await waitFor("the finder", () =>
			app.review.finderVisible() ? true : null,
		);
	});

	it("opens a file by keyboard from results that land after threads are hidden", async () => {
		const app = await setup({ repo: REPOSITORY, viewportHeight: 200 });
		await app.repo.open();
		await app.review.openPanel();
		const release = app.holdCommand("list_tracked_files");
		await app.review.openFileFinder();
		await waitFor("the pending finder request", () =>
			app.invokes().some(({ cmd }) => cmd === "list_tracked_files")
				? true
				: null,
		);
		await app.review.hideThreads(() => true);

		release();
		await waitFor("the tracked files", () =>
			app.review.finderRows().includes(NEXT_FILE) ? true : null,
		);
		await app.review.pressFinderKey("PageDown");
		expect(app.review.finderScrollTop()).toBeGreaterThan(0);
		await app.review.pressFinderKey("Enter");

		await waitFor("the selected file's content", () =>
			app.diffPane.contextLines().includes(NEXT_FILE_CONTENT) ? true : null,
		);
		expect(app.diffPane.selectedPath()).toBe(NEXT_FILE);
	});
});
