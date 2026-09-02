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
});
