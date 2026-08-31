import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const TWO_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
	],
};

describe("branch mutation", () => {
	afterEach(teardown);

	it("creates a branch onto the graph and deletes it through the confirmation", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await app.repo.open();

		await app.branches.create("feature");

		await expect(
			waitFor("the feature pill", () => {
				const pills = app.repo.refPills();
				return pills.includes("feature") ? pills : null;
			}),
		).resolves.toContain("feature");
		await waitFor("the checkout of feature", () =>
			app.branches.headBranch() === "feature" ? true : null,
		);

		await app.branches.checkout("main");
		await waitFor("the checkout of main", () =>
			app.branches.headBranch() === "main" ? true : null,
		);

		app.dialog.confirms();
		await app.branches.contextMenu("feature");
		app.contextMenu.choose("Delete");

		await waitFor("the feature branch to go", () =>
			app.branches.lists("feature") ? null : true,
		);
		await waitFor("the feature pill to go", () =>
			app.repo.refPills().includes("feature") ? null : true,
		);
	});
});
