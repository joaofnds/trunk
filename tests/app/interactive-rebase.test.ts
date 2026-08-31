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

const REBASE_STOPPED = "Rebase stopped — resolve it in the staging panel";

describe("an interactive rebase", () => {
	afterEach(teardown);

	it("offers the rebase item enabled on a commit in the checked-out line", async () => {
		const app = await setup({ repo: FOUR_COMMITS });
		await app.repo.open();

		await app.repo.contextMenu("C2");

		expect(app.contextMenu.items()).toContainEqual({
			label: "Interactive Rebase...",
			enabled: true,
		});
	});

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
		await app.settle();
		expect(app.branches.headBranch()).toBe("main");
		expect(app.repo.commitRows()).toEqual([
			"G-four",
			"G-three",
			"G-two",
			"G-one",
		]);
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
			waitFor("the rebased graph", () => {
				const rows = app.repo.commitRows();
				return rows.length === 3 ? rows : null;
			}),
		).resolves.toEqual(["G-four", "G-two", "G-one"]);
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
