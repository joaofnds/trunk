import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const WATCHED = "src/watched.ts";
const CONTENT = "const answer = 42;\nexport { answer };\n";

const ONE_TRACKED_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: WATCHED, content: CONTENT },
		{ step: "commit", message: "base" },
	],
};

/** Opens the tracked file, then deletes it under the open pane. */
async function deleteTheOpenFile(
	app: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
	await app.repo.open();
	await app.review.openPanel();
	await app.openTrackedFile("watched");

	app.repo.deleteWorkingTreeFile(WATCHED);
	await app.events.externalChange(app.repo.path);
	await waitFor("the failed read in the pane", () =>
		app.diffPane.showsLoadError() ? true : null,
	);
}

describe("a current-file view whose file stops being readable", () => {
	afterEach(teardown);

	it("keeps the path and leaves no line of the old content selectable", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });

		await deleteTheOpenFile(app);

		expect(app.diffPane.selectedPath()).toBe(WATCHED);
		expect(app.diffPane.contextLines()).toEqual([]);
	});

	it("shows the file again when a retry can read it", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await deleteTheOpenFile(app);

		app.repo.writeWorkingTreeFile(WATCHED, CONTENT);
		await app.diffPane.retry();

		const shown = await waitFor("the restored content", () => {
			const lines = app.diffPane.contextLines();
			return lines.length > 0 ? lines : null;
		});
		expect(shown).toEqual(["const answer = 42;", "export { answer };"]);
	});
});
