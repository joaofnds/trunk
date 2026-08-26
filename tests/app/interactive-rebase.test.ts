import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** doc-17's `noedit` shape: four commits, each adding its own file. */
const FOUR_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
		{ step: "file", path: "c3.txt", content: "3" },
		{ step: "commit", message: "C3" },
		{ step: "file", path: "c4.txt", content: "4" },
		{ step: "commit", message: "C4" },
	],
};

/** doc-17's `conflict` shape: every commit rewrites the same file, so dropping
 *  one leaves the next with nothing to apply onto. */
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

const REBASE_STOPPED = "Rebase stopped — resolve it in the staging panel";

describe("an interactive rebase", () => {
	afterEach(teardown);

	it("lands the commit it started from reordered above the rest", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();
		await app.repo.contextMenu("C2");
		app.contextMenu.choose("Interactive Rebase...");

		await app.rebaseEditor.move(2, 0);
		await app.rebaseEditor.start();

		await expect(
			waitFor("the reordered graph", () => {
				const rows = app.repo.commitRows();
				return rows[0] === "C2" ? rows : null;
			}),
		).resolves.toEqual(["C2", "C4", "C3", "C1"]);
		expect(app.staging.banner()).toBeNull();
	});

	it("leaves every commit's hash alone when the plan is unchanged", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();
		const before = app.repo.commitShas();
		await app.repo.contextMenu("C2");
		app.contextMenu.choose("Interactive Rebase...");

		await app.rebaseEditor.start();
		await app.settle();

		expect(app.repo.commitShas()).toEqual(before);
		expect(app.staging.banner()).toBeNull();
	});

	it("rebases the repository's first commit from the root", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();
		await app.repo.contextMenu("C1");
		app.contextMenu.choose("Interactive Rebase...");

		const toolbar = await app.rebaseEditor.toolbarLabel();
		await app.rebaseEditor.move(3, 2);
		await app.rebaseEditor.start();

		expect(toolbar).toBe("Rebasing main onto root");
		await expect(
			waitFor("the reordered graph", () => {
				const rows = app.repo.commitRows();
				return rows[2] === "C1" ? rows : null;
			}),
		).resolves.toEqual(["C4", "C3", "C1", "C2"]);
		expect(app.staging.banner()).toBeNull();
	});

	it("says so when a dropped commit leaves the next one unappliable", async () => {
		const app = await setup({ repo: ONE_REWRITTEN_FILE });
		await app.repo.open();
		await app.repo.contextMenu("G-two");
		app.contextMenu.choose("Interactive Rebase...");

		await app.rebaseEditor.setAction(1, "drop");
		await app.rebaseEditor.start();

		await expect(
			waitFor("the rebase-stopped toast", () => {
				const showing = app.toasts();
				return showing.length > 0 ? showing : null;
			}),
		).resolves.toEqual([REBASE_STOPPED]);
		await expect(
			waitFor("the rebase banner", () => app.staging.banner()),
		).resolves.toEqual(["Continue Rebase", "Skip", "Abort Rebase"]);
	});

});
