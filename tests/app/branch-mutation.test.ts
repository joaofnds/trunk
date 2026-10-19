import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** `wt-branch` checked out in linked worktree `wt`, and `main` in the main one. */
function heldByWorktree(...extra: RepoSpec["steps"]): RepoSpec {
	return {
		steps: [
			...TWO_COMMITS.steps,
			{ step: "branch", name: "wt-branch" },
			{ step: "checkout", name: "main" },
			{ step: "worktree", name: "wt", branch: "wt-branch" },
			...extra,
		],
	};
}

/** The worktree path the delete question names. */
function askedPath(question: string | undefined): string {
	const path = question?.match(
		/in the worktree at (\/[^,\n]*?)(?:,|\.\n)/,
	)?.[1];
	if (!path) throw new Error(`no worktree path in: ${question}`);
	return path;
}

/**
 * Asks to delete wt-branch a second time and waits for that question. The second
 * preflight reaches the host after anything the dismissed answer could have sent, so
 * once it is answered the first answer has been acted on, and a branch it deleted
 * would no longer be there to ask about.
 */
async function askedAgain(
	app: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
	await app.branches.contextMenu("wt-branch");
	app.contextMenu.choose("Delete");
	await waitFor("the delete question again", () =>
		app.dialog.shown.length === 2 ? true : null,
	);
}

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

	describe("when a linked worktree holds the branch", () => {
		it("removes the worktree and deletes the branch once the offer is accepted", async () => {
			const app = await setup({ repo: heldByWorktree() });
			await app.repo.open();

			app.dialog.confirms();
			await app.branches.contextMenu("wt-branch");
			app.contextMenu.choose("Delete");

			await waitFor("the wt-branch branch to go", () =>
				app.branches.lists("wt-branch") ? null : true,
			);
			const [question] = app.dialog.shown;
			expect(question).toContain("Remove that worktree and delete the branch?");
			expect(existsSync(askedPath(question))).toBe(false);
		});

		it("leaves the worktree and the branch when the offer is declined", async () => {
			const app = await setup({ repo: heldByWorktree() });
			await app.repo.open();

			await app.branches.contextMenu("wt-branch");
			app.contextMenu.choose("Delete");

			const question = await waitFor(
				"the delete question",
				() => app.dialog.shown.at(0) ?? null,
			);
			await askedAgain(app);
			expect(app.branches.lists("wt-branch")).toBe(true);
			expect(existsSync(join(askedPath(question), "c1.txt"))).toBe(true);
		});

		describe("when the worktree has uncommitted changes", () => {
			const dirty = heldByWorktree({
				step: "worktreeFile",
				worktree: "wt",
				path: "c1.txt",
				content: "unsaved",
			});

			it("warns, then removes both on the go-ahead", async () => {
				const app = await setup({ repo: dirty });
				await app.repo.open();

				app.dialog.confirms();
				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				await waitFor("the wt-branch branch to go", () =>
					app.branches.lists("wt-branch") ? null : true,
				);
				const [question] = app.dialog.shown;
				expect(question).toContain("It has uncommitted or untracked changes.");
				expect(question).toContain("Remove it anyway and delete the branch?");
				expect(existsSync(askedPath(question))).toBe(false);
			});

			it("changes nothing when the user backs out of the warning", async () => {
				const app = await setup({ repo: dirty });
				await app.repo.open();

				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				const question = await waitFor(
					"the delete warning",
					() => app.dialog.shown.at(0) ?? null,
				);
				await askedAgain(app);
				expect(question).toContain("removing it may lose work");
				expect(app.branches.lists("wt-branch")).toBe(true);
				expect(readFileSync(join(askedPath(question), "c1.txt"), "utf8")).toBe(
					"unsaved",
				);
			});
		});
	});
});
