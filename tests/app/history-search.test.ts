import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const THREE_SUMMARIES: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a" },
		{ step: "commit", message: "alpha first" },
		{ step: "file", path: "b.txt", content: "b" },
		{ step: "commit", message: "alpha second" },
		{ step: "file", path: "c.txt", content: "c" },
		{ step: "commit", message: "beta" },
	],
};

const FILE_ROW = '[data-testid="staging-file"]';

describe("history search", () => {
	afterEach(teardown);

	it("counts the matches and selects the first one", async () => {
		const app = await setup({ repo: THREE_SUMMARIES });
		await app.repo.open();
		await app.events.searchToggle();

		await app.search.query("alpha");

		await expect(
			waitFor("the match count", () => {
				const count = app.search.matchCount();
				return count?.includes(" of ") ? count : null;
			}),
		).resolves.toBe("1 of 2");
		await waitFor("the selected commit's files", () =>
			document.querySelector(FILE_ROW)?.textContent?.includes("b.txt")
				? true
				: null,
		);
	});
});
