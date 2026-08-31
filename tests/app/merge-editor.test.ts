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

describe("the merge editor", () => {
	afterEach(teardown);

	it("saves the taken side into the file and marks it resolved", async () => {
		const app = await setup({ repo: ONE_REWRITTEN_FILE });
		await app.repo.open();
		await app.repo.contextMenu("G-two");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.setAction(1, "drop");
		await app.rebaseEditor.start();
		await waitFor("the rebase banner", () => app.staging.banner());

		await app.staging.openConflictedFile("g.txt");
		await app.mergeEditor.takeAllIncoming();
		await app.mergeEditor.saveAndResolve();

		await waitFor("g.txt in the resolved section", () =>
			app.staging.stagedFiles().some((file) => file.includes("g.txt"))
				? true
				: null,
		);
		expect(app.repo.workingTreeFile("g.txt").trim()).toBe("four");
	});
});
