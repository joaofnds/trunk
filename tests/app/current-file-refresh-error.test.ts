import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const WATCHED = "src/watched.ts";
const CONTENT = "const answer = 42;\nexport { answer };\n";
const NOTES = "docs/notes.md";

const ONE_TRACKED_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: WATCHED, content: CONTENT },
		{ step: "file", path: NOTES, content: "# Title\n\nA paragraph.\n" },
		{ step: "commit", message: "base" },
	],
};

/** Opens a tracked file, then deletes it under the open pane. */
async function deleteTheOpenFile(
	app: Awaited<ReturnType<typeof setup>>,
	query: string,
	path: string,
): Promise<void> {
	app.repo.deleteWorkingTreeFile(path);
	await app.events.externalChange(app.repo.path);
	await waitFor(`the failed read of ${query} in the pane`, () =>
		app.diffPane.showsLoadError() ? true : null,
	);
}

describe("a current-file view whose file stops being readable", () => {
	afterEach(teardown);

	it("keeps the path and shows the failed read in place of the lines", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");

		await deleteTheOpenFile(app, "watched", WATCHED);

		expect(app.diffPane.selectedPath()).toBe(WATCHED);
		expect(app.diffPane.contextLines()).toEqual([]);
	});

	// The rendered view outranks the failed-read presentation in DiffViewer, so
	// it is the surface that says whether the unreadable file's payload is still
	// in hand: keep it and the pane renders the document that has gone.
	it("takes the rendered markdown view down with the file", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("notes");
		await app.diffPane.showRendered();
		await waitFor("the rendered view", () =>
			app.diffPane.rendersMarkdown() ? true : null,
		);

		await deleteTheOpenFile(app, "notes", NOTES);

		expect(app.diffPane.rendersMarkdown()).toBe(false);
	});

	it("shows the file again when a retry can read it", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");
		await deleteTheOpenFile(app, "watched", WATCHED);

		app.repo.writeWorkingTreeFile(WATCHED, CONTENT);
		await app.diffPane.retry();

		const shown = await waitFor("the restored content", () => {
			const lines = app.diffPane.contextLines();
			return lines.length > 0 ? lines : null;
		});
		expect(shown).toEqual(["const answer = 42;", "export { answer };"]);
	});
});
