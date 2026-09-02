import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";

const THREE_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
		{ step: "file", path: "c3.txt", content: "3" },
		{ step: "commit", message: "C3" },
	],
};

/** Two branches whose tips are different commits, so checking the other one out
 *  lands HEAD somewhere the undo never left it. `sidetrack` carries a commit of
 *  its own: branching off the shared root would put both tips on the same oid,
 *  and a redo there is still the commit the user undid. */
const TWO_BRANCHES: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "branch", name: "sidetrack" },
		{ step: "checkout", name: "sidetrack" },
		{ step: "file", path: "s1.txt", content: "s" },
		{ step: "commit", message: "S1" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
	],
};

const REVERT_ROW = 'Revert "C2"';

describe("commit actions", () => {
	afterEach(teardown);

	it("lands a revert above the untouched original, and Undo hands it to Redo with its message", async () => {
		const app = await setup({ repo: THREE_COMMITS });
		await app.repo.open();

		await app.repo.contextMenu("C2");
		app.contextMenu.choose("Revert");
		await expect(app.messageEditor.text()).resolves.toContain(REVERT_ROW);
		await app.messageEditor.save();

		await expect(
			app.elapseUntil("the revert commit", () => {
				const rows = app.repo.commitRows();
				return rows[0] === REVERT_ROW ? rows : null;
			}),
		).resolves.toEqual([REVERT_ROW, "C3", "C2", "C1"]);

		await app.toolbar.undo();

		await app.elapseUntil("the revert to leave the graph", () =>
			app.repo.commitRows().includes(REVERT_ROW) ? null : true,
		);

		await app.toolbar.redo();

		await expect(
			app.elapseUntil("the redone revert", () => {
				const rows = app.repo.commitRows();
				return rows[0] === REVERT_ROW ? rows : null;
			}),
		).resolves.toEqual([REVERT_ROW, "C3", "C2", "C1"]);
	});

	it("withdraws Redo once HEAD moves away from where the undo left it", async () => {
		const app = await setup({ repo: TWO_BRANCHES });
		await app.repo.open();

		await app.toolbar.undo();

		await app.elapseUntil("C2 to leave the graph", () =>
			app.repo.commitRows().includes("C2") ? null : true,
		);
		expect(app.toolbar.offersRedo()).toBe(true);

		await app.branches.checkout("sidetrack");
		await app.elapseUntil("sidetrack to carry HEAD", () =>
			app.branches.headBranch() === "sidetrack" ? true : null,
		);

		// The sidebar tags the new HEAD before the toolbar has asked where HEAD
		// went, so the offer is what to wait on, not the tag.
		await expect(
			app.elapseUntil("Redo to be withdrawn", () =>
				app.toolbar.offersRedo() ? null : true,
			),
		).resolves.toBe(true);
	});
});
