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

describe("the review file finder while comments are hidden", () => {
	afterEach(teardown);

	it("ignores a finder response invalidated by hiding threads", async () => {
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

		await app.review.showReviewFilter(
			"none",
			() => !app.review.finderVisible(),
		);
		release();
		await app.settled();

		expect(app.review.finderVisible()).toBe(false);
	});

	it("requires a fresh finder gesture after the invalidated response", async () => {
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

		await app.review.showReviewFilter(
			"none",
			() => !app.review.finderVisible(),
		);
		await app.review.showReviewFilter("all", () => !app.review.finderVisible());
		release();
		await app.settled();

		expect(app.review.finderVisible()).toBe(false);
		await app.review.openFileFinder();
		await waitFor("the fresh finder response", () =>
			app.review.finderVisible() ? true : null,
		);
	});
});
