import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { pressButton } from "./drivers/dom.js";
import type { AppDriver } from "./drivers/index.js";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const ONE_COMMIT: RepoSpec = {
	steps: [
		{ step: "file", path: "a.txt", content: "a" },
		{ step: "commit", message: "First" },
	],
};

const NESTED_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: "src/a.txt", content: "a" },
		{ step: "commit", message: "First" },
	],
};

const MADE_ELSEWHERE = "Made elsewhere";

/** A commit made in a terminal, outside the application. */
function commitElsewhere(repoPath: string): void {
	execFileSync("git", ["commit", "--allow-empty", "-m", MADE_ELSEWHERE], {
		cwd: repoPath,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});
}

/** The repository's view has asked to hear its changes. */
async function viewListenerRequested(app: AppDriver): Promise<void> {
	await waitFor("the view's repo-changed listener", () =>
		app
			.invokes()
			.some(
				({ cmd, args }) =>
					cmd === "plugin:event|listen" && args.event === "repo-changed",
			)
			? true
			: null,
	);
}

function showsCommitMadeElsewhere(app: AppDriver): true | null {
	return app.repo.commitRows().includes(MADE_ELSEWHERE) ? true : null;
}

describe("opening a repository", () => {
	afterEach(teardown);

	it("shows a commit the watcher reported before the repository's view existed", async () => {
		const app = await setup({ repo: ONE_COMMIT });
		await app.settled();
		const opening = app.holdNextCommandReply("open_repo");
		await app.repo.pick();
		await opening.entered;
		commitElsewhere(app.repo.path);
		await app.events.externalChange(app.repo.path);
		const rowsBeforeTheView = app.repo.commitRows();

		opening.release();

		expect(rowsBeforeTheView).toEqual([]);
		await expect(
			app.elapseUntil("the commit made elsewhere", () =>
				showsCommitMadeElsewhere(app),
			),
		).resolves.toBe(true);
	});

	it("shows the repository while its recent-list update is still held", async () => {
		const app = await setup({ repo: ONE_COMMIT });
		await app.settled();
		const releaseRecents = app.holdPrefsGet("recent_repos");

		await app.repo.open();
		const rows = app.repo.commitRows();
		releaseRecents();
		await app.settled();

		expect(rows).toContain("First");
	});

	it("shows a commit the watcher reported while the view was registering its listener", async () => {
		const app = await setup({ repo: ONE_COMMIT });
		await app.settled();
		const releaseListeners = app.holdCommand("plugin:event|listen");
		await app.repo.pick();
		await viewListenerRequested(app);
		await app.settled();
		commitElsewhere(app.repo.path);
		await app.events.externalChange(app.repo.path);

		releaseListeners();

		await expect(
			app.elapseUntil("the commit made elsewhere", () =>
				showsCommitMadeElsewhere(app),
			),
		).resolves.toBe(true);
	});

	it("opens the repository a chosen folder lies inside once the user agrees", async () => {
		const app = await setup({ repo: NESTED_FILE });
		await app.settled();
		app.dialog.chooses(`${app.repo.path}/src`);
		app.dialog.confirms();

		await pressButton("Open Repository");

		await expect(
			app.elapseUntil("the repository's commits", () =>
				app.repo.commitRows().includes("First") ? true : null,
			),
		).resolves.toBe(true);
		expect(app.dialog.questions).toHaveLength(1);
		expect(app.dialog.questions[0]).toMatch(
			/is a folder inside the repository .*\. Open that repository\?$/,
		);
	});

	it("opens a newer Welcome choice while an older folder lookup is returning", async () => {
		const app = await setup({ repo: NESTED_FILE });
		await app.settled();
		app.dialog.chooses(`${app.repo.path}/src`);
		app.dialog.confirms();
		const lookup = app.holdNextCommandReply("enclosing_repository");

		await pressButton("Open Repository");
		await lookup.entered;
		await app.repo.open();
		lookup.release();
		await app.settled();

		expect(app.repo.commitRows()).toContain("First");
		expect(app.dialog.questions).toEqual([]);
	});
});
