import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { type RepoSpec, setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const SHADOWED_BRANCH: RepoSpec = {
	steps: [
		{ step: "file", path: "c1.txt", content: "1" },
		{ step: "commit", message: "C1" },
		{ step: "file", path: "c2.txt", content: "2" },
		{ step: "commit", message: "C2" },
		{ step: "tag", name: "decoy" },
		{ step: "file", path: "c3.txt", content: "3" },
		{ step: "commit", message: "C3" },
		{ step: "branch", name: "decoy" },
		...Array.from({ length: 12 }, (_, index) => ({
			step: "branch" as const,
			name: `topic-${index}`,
		})),
		{ step: "file", path: "c4.txt", content: "4" },
		{ step: "commit", message: "C4" },
	],
};

const DIVERGED: RepoSpec = {
	steps: [
		{ step: "file", path: "base.txt", content: "base" },
		{ step: "commit", message: "Base" },
		{ step: "branch", name: "alternate" },
		{ step: "checkout", name: "alternate" },
		{ step: "file", path: "alt.txt", content: "alt" },
		{ step: "commit", message: "Alternate tip" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "fork.txt", content: "fork" },
		{ step: "commit", message: "Fork" },
		{ step: "branch", name: "topic" },
		{ step: "checkout", name: "topic" },
		{ step: "file", path: "topic.txt", content: "topic" },
		{ step: "commit", message: "Topic tip" },
		{ step: "checkout", name: "main" },
		{ step: "file", path: "main.txt", content: "main" },
		{ step: "commit", message: "Main tip" },
		{ step: "branch", name: "sibling" },
	],
};

describe("interactive rebase preview", () => {
	afterEach(teardown);

	it.each([
		["C3", "C2"],
		["C2", "C1"],
	])(
		"labels the base of %s by its commit when only a tag or no ref points at it",
		async (commit, base) => {
			const app = await setup({ repo: SHADOWED_BRANCH });
			await app.repo.open();
			await app.settled();
			const baseSha = app.repo.shaOf(base);
			await app.repo.contextMenu(commit);
			const before = app.invokes().length;

			app.contextMenu.choose("Interactive Rebase...");

			const label = await app.rebaseEditor.toolbarLabel();
			const previewReads = app
				.invokes()
				.slice(before)
				.map(({ cmd }) => cmd)
				.filter((cmd) =>
					["get_rebase_todo", "list_refs", "resolve_ref"].includes(cmd),
				);
			expect.soft(label).toBe(`Rebasing main onto ${baseSha}`);
			expect(previewReads).toEqual(["get_rebase_todo"]);
		},
	);

	it("keeps the newer commit plan when an older branch plan arrives", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();
		await app.branches.contextMenu("topic");
		const preview = app.holdNextCommandReply("get_rebase_todo");
		app.contextMenu.choose("Interactive Rebase topic...");
		await preview.entered;

		await app.repo.contextMenu("Base");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.toolbarLabel();
		preview.release();
		await waitFor("all preview reads to return", () =>
			app.answeredEverything ? true : null,
		);
		await app.settled();

		await expect(app.rebaseEditor.toolbarLabel()).resolves.toBe(
			"Rebasing main onto root",
		);
		await expect(app.rebaseEditor.rows()).resolves.toEqual([
			"Main tip",
			"Fork",
			"Base",
		]);
	});

	it("keeps the source, fork point and commits from the same checkout", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();
		const forkPoint = app.repo.shaOf("Fork");
		await app.branches.contextMenu("topic");
		const preview = app.holdNextCommandReply("get_rebase_todo");
		app.contextMenu.choose("Interactive Rebase topic...");
		await preview.entered;

		await app.branches.checkout("alternate");
		await waitFor("alternate to be checked out", () =>
			app.branches.headBranch() === "alternate" ? true : null,
		);
		preview.release();

		await expect(app.rebaseEditor.toolbarLabel()).resolves.toBe(
			`Rebasing main onto ${forkPoint}`,
		);
		await expect(app.rebaseEditor.rows()).resolves.toEqual(["Main tip"]);
	});

	it("refuses to start on another branch at the previewed tip", async () => {
		const app = await setup({ repo: DIVERGED });
		await app.repo.open();
		await app.repo.contextMenu("Fork");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.setAction(0, "drop");
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", app.repo.path, ...args], {
				encoding: "utf8",
				env: { ...process.env, HOME: app.home, GIT_CONFIG_NOSYSTEM: "1" },
			}).trim();
		const tip = git("rev-parse", "HEAD");

		git("switch", "sibling");
		await app.rebaseEditor.start();
		await waitFor("the start to return", () =>
			app.answeredEverything ? true : null,
		);
		await app.settled();

		expect.soft(git("rev-parse", "sibling")).toBe(tip);
		expect(git("rev-parse", "main")).toBe(tip);
		expect(app.toasts()).toContain(
			"The branch changed after the rebase editor opened. Open it again to see the current commits.",
		);
		expect(app.rebaseEditor.isOpen()).toBe(false);
	});
});
