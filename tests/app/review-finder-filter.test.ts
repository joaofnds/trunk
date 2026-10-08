import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const REPOSITORY: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "src/main.ts",
			content: "export const main = true;\n",
		},
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

	it("shows a response that lands after threads are hidden", async () => {
		const app = await setup({ repo: REPOSITORY });
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
		await app.settled();

		expect(app.review.finderVisible()).toBe(true);
	});
});
