import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** `wt-branch` alone on C1, so its graph pill is not folded into main's. */
const heldOnItsOwnCommit: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "branch", name: "wt-branch" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
		{ step: "worktree", name: "wt", branch: "wt-branch" },
	],
};

/** Stops an interactive rebase in the linked worktree that has `branch` checked out,
 *  as `git rebase -i` leaves it at an `edit` step, and returns that worktree's path. */
function stopMidRebase(repoPath: string, branch: string): string {
	const worktree = execFileSync("git", ["worktree", "list", "--porcelain"], {
		cwd: repoPath,
		encoding: "utf8",
	})
		.split("\n\n")
		.find((entry) => entry.includes(`branch refs/heads/${branch}`))
		?.match(/^worktree (.*)$/m)?.[1];
	if (!worktree) throw new Error(`no worktree has ${branch} checked out`);

	execFileSync("git", ["rebase", "-i", "HEAD~1"], {
		cwd: worktree,
		env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak s/^pick/edit/" },
	});
	return worktree;
}

/** The worktree path the delete question or refusal names. */
function askedPath(question: string | undefined): string {
	const path = question?.match(
		/[Ww]orktree at (\/[^,\n]*?)(?:,|\.\n| has )/,
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

		it("removes the worktree and deletes the branch from its graph pill", async () => {
			const app = await setup({ repo: heldOnItsOwnCommit });
			await app.repo.open();

			app.dialog.confirms();
			await app.repo.openRefPillMenu("wt-branch");
			app.contextMenu.choose("Delete");

			await waitFor("the wt-branch pill to go", () =>
				app.repo.refPills().includes("wt-branch") ? null : true,
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

		describe("when the worktree changes while the offer is open", () => {
			it("asks again with the warning, then removes both on the go-ahead", async () => {
				const app = await setup({ repo: heldByWorktree() });
				await app.repo.open();
				app.dialog.whileAsking((question) =>
					writeFileSync(join(askedPath(question), "c1.txt"), "unsaved"),
				);

				app.dialog.confirms();
				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				await waitFor("the wt-branch branch to go", () =>
					app.branches.lists("wt-branch") ? null : true,
				);
				const [offer, warning] = app.dialog.shown;
				expect(offer).toContain("Remove that worktree and delete the branch?");
				expect(warning).toContain("It has uncommitted or untracked changes.");
				expect(existsSync(askedPath(warning))).toBe(false);
			});
		});

		describe("when the worktree lets go of the branch while the offer is open", () => {
			it("asks again with the plain question, then deletes only the branch", async () => {
				const app = await setup({ repo: heldByWorktree() });
				await app.repo.open();
				app.dialog.whileAsking(() =>
					writeFileSync(
						join(app.repo.path, ".git/worktrees/wt/HEAD"),
						"ref: refs/heads/main\n",
					),
				);

				app.dialog.confirms();
				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				await waitFor("the wt-branch branch to go", () =>
					app.branches.lists("wt-branch") ? null : true,
				);
				const [offer, plain] = app.dialog.shown;
				expect(plain).toContain("Delete branch 'wt-branch'?");
				expect(existsSync(join(askedPath(offer), "c1.txt"))).toBe(true);
			});
		});

		describe("when the branch will not delete after the worktree went", () => {
			it("reports it without asking again", async () => {
				const app = await setup({ repo: heldByWorktree() });
				await app.repo.open();
				app.dialog.whileAsking(() =>
					writeFileSync(
						join(app.repo.path, ".git/refs/heads/wt-branch.lock"),
						"",
					),
				);

				app.dialog.confirms();
				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				const [report] = await waitFor("the delete error", () => {
					const toasts = app.toasts();
					return toasts.length > 0 ? toasts : null;
				});
				expect(report).toContain(
					"was removed but the branch could not be deleted",
				);
				expect(app.dialog.questions).toHaveLength(1);
			});
		});

		describe("when the worktree does not point back at this repository", () => {
			const mismatched = heldByWorktree({
				step: "worktreeFile",
				worktree: "wt",
				path: ".git",
				content: "gitdir: /nowhere\n",
			});

			it("refuses with the path and removes nothing", async () => {
				const app = await setup({ repo: mismatched });
				await app.repo.open();

				app.dialog.confirms();
				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				const refusal = await waitFor(
					"the delete refusal",
					() => app.dialog.shown.at(0) ?? null,
				);
				expect(app.dialog.questions).toEqual([]);
				await askedAgain(app);
				expect(refusal).toContain("does not point back at this repository");
				expect(app.toasts()).toEqual([]);
				expect(app.branches.lists("wt-branch")).toBe(true);
				expect(existsSync(join(askedPath(refusal), "c1.txt"))).toBe(true);
			});
		});

		describe("when the worktree is rebasing the branch", () => {
			it("refuses with the path before asking and keeps the branch", async () => {
				const app = await setup({ repo: heldByWorktree() });
				const worktree = stopMidRebase(app.repo.path, "wt-branch");
				await app.repo.open();

				app.dialog.confirms();
				await app.branches.contextMenu("wt-branch");
				app.contextMenu.choose("Delete");

				const refusal = await waitFor(
					"the delete refusal",
					() => app.dialog.shown.at(0) ?? null,
				);
				expect(app.dialog.questions).toEqual([]);
				await askedAgain(app);
				expect(refusal).toBe(
					`Cannot delete 'wt-branch' while the worktree at ${worktree} is rebasing it. Finish or abort the rebase there, then delete again.`,
				);
				expect(app.branches.lists("wt-branch")).toBe(true);
			});
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
