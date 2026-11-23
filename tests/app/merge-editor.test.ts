import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const INCOMING = `${"a long incoming line ".repeat(30)}with a trailing tab\t`;

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
		{ step: "file", path: "g.txt", content: INCOMING },
		{ step: "commit", message: "G-four" },
	],
};

async function openConflict() {
	const app = await setup({ repo: ONE_REWRITTEN_FILE });
	await app.repo.open();
	await app.repo.contextMenu("G-two");
	app.contextMenu.choose("Interactive Rebase...");
	await app.rebaseEditor.setAction(1, "drop");
	await app.rebaseEditor.start();
	await waitFor("the rebase banner", () => app.staging.banner());
	await app.staging.openConflictedFile("g.txt");
	return app;
}

describe("the merge editor", () => {
	afterEach(teardown);

	it("keeps picked Output available when another process aborts the rebase", async () => {
		const app = await openConflict();
		await app.mergeEditor.takeAllIncoming();

		await app.events.rebaseAbortedElsewhere(app.repo.path);

		const previous = await app.elapseUntil("the picked Output to recover", () =>
			app.mergeEditor.recoveredOutput(),
		);
		expect(previous).toBe(INCOMING);
	});

	it("can reopen a closed draft after another process stages its file", async () => {
		const app = await openConflict();
		await app.mergeEditor.typeOutput("my resolution");
		await app.mergeEditor.close();
		execFileSync("git", ["add", "g.txt"], { cwd: app.repo.path });
		await app.events.externalChange(app.repo.path, [".git/index"]);
		await app.elapseUntil("g.txt to move to staged", () =>
			app.staging.stagedFiles().some((file) => file.includes("g.txt"))
				? true
				: null,
		);
		expect(app.mergeEditor.isShowing()).toBe(false);

		await app.mergeEditor.recover("g.txt");

		await expect
			.poll(() => app.mergeEditor.recoveredOutput())
			.toBe("my resolution");
	});

	it("copies the conflict path and keeps wrapping enabled in the staged diff", async () => {
		const app = await openConflict();
		await app.mergeEditor.fileContextMenu("g.txt");
		app.contextMenu.choose("Copy Absolute Path");
		expect(app.clipboard.text).toBe(`${app.repo.path}/g.txt`);
		await app.mergeEditor.toggleWordWrap();
		await expect.poll(() => app.mergeEditor.wrapsOutput()).toBe(true);
		await app.mergeEditor.takeAllIncoming();
		await app.mergeEditor.saveAndResolve();
		await app.staging.openStagedFile("g.txt");
		await expect.poll(() => app.diffPane.wrapsLine(INCOMING)).toBe(true);
	});

	it("saves the taken side into the file and marks it resolved", async () => {
		const app = await openConflict();
		await app.mergeEditor.takeAllIncoming();
		await app.mergeEditor.saveAndResolve();

		await waitFor("g.txt in the resolved section", () =>
			app.staging.stagedFiles().some((file) => file.includes("g.txt"))
				? true
				: null,
		);
		expect(app.repo.workingTreeFile("g.txt")).toBe(INCOMING);
		expect(
			execFileSync("git", ["show", ":g.txt"], {
				cwd: app.repo.path,
				encoding: "utf8",
			}),
		).toBe(INCOMING);
	});
});
