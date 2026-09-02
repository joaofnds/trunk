import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** doc-17's `conflict` shape, as in interactive-rebase.test.ts: every commit
 *  rewrites the same file, so dropping one strands the next on a conflict. */
const ONE_REWRITTEN_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: "g.txt", content: "one" },
		{ step: "commit", message: "G-one" },
		{ step: "file", path: "g.txt", content: "two" },
		{ step: "commit", message: "G-two" },
		{ step: "file", path: "g.txt", content: "three" },
		{ step: "commit", message: "G-three" },
		{ step: "file", path: "g.txt", content: "four" },
		{ step: "commit", message: "G-four" },
	],
};

describe("a stopped rebase", () => {
	afterEach(teardown);

	it("aborts a stopped rebase back to the pre-rebase graph, then lands the resolution on Continue", async () => {
		const app = await setup({ repo: ONE_REWRITTEN_FILE });
		await app.repo.open();
		const before = app.repo.commitShas();
		await app.repo.contextMenu("G-two");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.setAction(1, "drop");
		await app.rebaseEditor.start();
		await waitFor("the rebase banner", () => app.staging.banner());

		app.dialog.confirms();
		await app.staging.abortRebase();

		await waitFor("the banner to clear", () =>
			app.staging.banner() ? null : true,
		);

		const rows = await app.elapseUntil(
			"the pre-rebase graph back on main",
			() => {
				const showing = app.repo.commitRows();
				return showing.length === 4 && app.branches.headBranch() === "main"
					? showing
					: null;
			},
		);
		expect(rows).toEqual(["G-four", "G-three", "G-two", "G-one"]);
		expect(app.repo.commitShas()).toEqual(before);

		await app.repo.contextMenu("G-two");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.setAction(1, "drop");
		await app.rebaseEditor.start();
		await waitFor("the rebase banner", () => app.staging.banner());

		app.repo.writeWorkingTreeFile("g.txt", "four");
		await app.staging.markAllResolved();
		await app.staging.continueRebase();

		await waitFor("the banner to clear", () =>
			app.staging.banner() ? null : true,
		);

		await expect(
			app.elapseUntil("the rebased graph", () => {
				const rows = app.repo.commitRows();
				return rows.length === 3 ? rows : null;
			}),
		).resolves.toEqual(["G-four", "G-two", "G-one"]);
	});
});
