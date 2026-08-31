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

/** doc-17's `fork` shape: `feature` leaves `main` at `C2` and `main` carries on,
 *  so the two branches share a fork point no ref sits on. */
const FORKED: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
		{ step: "branch", name: "feature" },
		{ step: "checkout", name: "feature" },
		{ step: "file", path: "f1.txt", content: "f" },
		{ step: "commit", message: "F1" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "c3.txt", content: "3" },
		{ step: "commit", message: "C3" },
		{ step: "file", path: "c4.txt", content: "4" },
		{ step: "commit", message: "C4" },
	],
};

describe("rebase base resolution", () => {
	afterEach(teardown);

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

	it("lists what a branch is ahead of its fork point by", async () => {
		const app = await setup({ repo: FORKED });
		await app.repo.open();
		const forkPoint = app.repo.shaOf("C2");
		await app.branches.contextMenu("feature");

		app.contextMenu.choose("Interactive Rebase feature...");

		await expect(app.rebaseEditor.rows()).resolves.toEqual(["C4", "C3"]);
		await expect(app.rebaseEditor.toolbarLabel()).resolves.toBe(
			`Rebasing main onto ${forkPoint}`,
		);
	});
});
