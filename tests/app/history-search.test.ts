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

	it("selects the first surviving match when a branch is hidden during the initial search", async () => {
		const app = await setup({
			repo: {
				steps: [
					{ step: "file", path: "root.txt", content: "root" },
					{ step: "commit", message: "root change" },
					{ step: "branch", name: "topic" },
					{ step: "checkout", name: "topic" },
					{ step: "file", path: "topic.txt", content: "topic" },
					{ step: "commit", message: "topic change" },
					{ step: "checkout", name: "main" },
				],
			},
		});
		await app.repo.open();
		await app.events.searchToggle();
		const searchReads = () =>
			app.invokes().filter(({ cmd }) => cmd === "search_commits");
		const release = app.holdCommand("search_commits");
		await app.search.query("change");
		await waitFor("the initial search to reach the host boundary", () =>
			searchReads().length === 1 ? true : null,
		);

		await app.branches.toggleVisibility("topic");
		await app.elapseUntil(
			"the replacement search to reach the host boundary",
			() => (searchReads().length === 2 ? true : null),
		);
		release();

		await waitFor(
			"the surviving match count and selected commit's files",
			() =>
				app.search.matchCount() === "1 of 1" &&
				app.repo.commitFiles().includes("A root.txt")
					? true
					: null,
		);
		expect(app.repo.commitRows().join("\n")).not.toContain("topic change");
		expect(app.toasts()).toEqual([]);
	});
});
