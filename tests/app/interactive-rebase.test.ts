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

/** A side commit merged back into main between the oldest commit and HEAD. */
const MERGE_ABOVE_THE_BASE: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a" },
		{ step: "commit", message: "A" },
		{ step: "file", path: "b.txt", content: "b" },
		{ step: "commit", message: "B" },
		{ step: "branch", name: "side" },
		{ step: "checkout", name: "side" },
		{ step: "file", path: "s.txt", content: "s" },
		{ step: "commit", message: "S" },
		{ step: "checkout", name: "main" },
		{ step: "merge", branch: "side" },
		{ step: "file", path: "c.txt", content: "c" },
		{ step: "commit", message: "C" },
	],
};

/** A feature branch, checked out, that merged main in after main moved on. */
const MAIN_MERGED_INTO_THE_BRANCH: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a" },
		{ step: "commit", message: "A" },
		{ step: "branch", name: "feature" },
		{ step: "checkout", name: "feature" },
		{ step: "file", path: "f1.txt", content: "f1" },
		{ step: "commit", message: "F1" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "b.txt", content: "b" },
		{ step: "commit", message: "B" },
		{ step: "checkout", name: "feature" },
		{ step: "merge", branch: "main" },
		{ step: "file", path: "f2.txt", content: "f2" },
		{ step: "commit", message: "F2" },
	],
};

/** The refusal names the merge by its short hash, which the fixture does not
 *  pin, so the toast is matched up to that hash. */
function mergeRefusal(summary: string): RegExp {
	return new RegExp(
		`^Interactive rebase can't replay merge commits\\. [0-9a-f]{7} ${summary} is a merge in this range\\.$`,
	);
}

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

		const refreshesBefore = app.refreshes();

		await app.rebaseEditor.start();

		await app.elapseUntil("the graph the rebase refetched", () =>
			app.refreshes() > refreshesBefore && app.repo.commitRows().length === 4
				? true
				: null,
		);
		expect(app.repo.commitShas()).toEqual(before);
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

	describe("over a range holding a merge", () => {
		it("refuses from a commit below the merge, naming it, and opens no editor", async () => {
			const app = await setup({ repo: MERGE_ABOVE_THE_BASE });
			await app.repo.open();
			await app.repo.contextMenu("A");

			app.contextMenu.choose("Interactive Rebase...");

			const toasts = await waitFor("the merge refusal", () => {
				const showing = app.toasts();
				return showing.length > 0 ? showing : null;
			});
			expect(toasts).toEqual([
				expect.stringMatching(mergeRefusal("Merge branch 'side'")),
			]);
			expect(app.rebaseEditor.isOpen()).toBe(false);
		});

		it("refuses from a branch merged into the checked-out one", async () => {
			const app = await setup({ repo: MAIN_MERGED_INTO_THE_BRANCH });
			await app.repo.open();
			await app.repo.openRefPillMenu("main");

			app.contextMenu.choose("Interactive Rebase main...");

			const toasts = await waitFor("the merge refusal", () => {
				const showing = app.toasts();
				return showing.length > 0 ? showing : null;
			});
			expect(toasts).toEqual([
				expect.stringMatching(mergeRefusal("Merge branch 'main'")),
			]);
			expect(app.rebaseEditor.isOpen()).toBe(false);
		});

		it("offers the rebase item disabled on the merge itself", async () => {
			const app = await setup({ repo: MERGE_ABOVE_THE_BASE });
			await app.repo.open();

			await app.repo.contextMenu("Merge branch 'side'");

			expect(app.contextMenu.items()).toContainEqual({
				label: "Interactive Rebase...",
				enabled: false,
			});
		});
	});
});
