import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const WATCHED = "src/watched.ts";
const BEFORE = "const answer = 42;\nexport { answer };\n";
/** The same distinctive block, one line further down and reworded: what an
 *  outside editor leaves behind, and what the open pane has to catch up to. */
const AFTER = "const inserted = 0;\nconst answer = 43;\nexport { answer };\n";
/** The line the edit both moved and reworded: selecting it by what the pane
 *  shows is how a test tells the displayed line numbers from the stale ones. */
const MOVED_BLOCK = "const answer = 43;";

/** One tracked file no pending change touches: the finder is the only way into
 *  it, so what the pane shows is what the finder's read returned. */
const ONE_TRACKED_FILE: RepoSpec = {
	steps: [
		{ step: "file", path: WATCHED, content: BEFORE },
		{ step: "commit", message: "base" },
	],
};

describe("a current-file view whose file changes on disk", () => {
	afterEach(teardown);

	it("shows the new content without the user reopening the file", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");

		app.repo.writeWorkingTreeFile(WATCHED, AFTER);
		await app.events.externalChange(app.repo.path);

		const shown = await waitFor("the edited content in the open pane", () => {
			const lines = app.diffPane.contextLines();
			return lines.includes(MOVED_BLOCK) ? lines : null;
		});
		expect(shown).toEqual([
			"const inserted = 0;",
			MOVED_BLOCK,
			"export { answer };",
		]);
		expect(app.diffPane.selectedPath()).toBe(WATCHED);
	});

	it("drops a selection made against the payload it replaces", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");
		await app.review.selectLine(1);
		expect(app.review.canCommentOnSelection()).toBe(true);

		app.repo.writeWorkingTreeFile(WATCHED, AFTER);
		await app.events.externalChange(app.repo.path);
		await waitFor("the edited content in the open pane", () =>
			app.diffPane.contextLines().includes(MOVED_BLOCK) ? true : null,
		);

		expect(app.review.canCommentOnSelection()).toBe(false);
	});

	// The composer captures its range when it opens and the backend re-reads the
	// block at submit, so a refresh under an open composer neither moves the range
	// nor discards the text. Refreshing the pane does not close the window between
	// capture and submit; it keeps the editor-lifetime contract as it stands.
	it("leaves an open composer's text and captured range alone", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");
		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("half a thought");

		app.repo.writeWorkingTreeFile(WATCHED, AFTER);
		await app.events.externalChange(app.repo.path);
		await waitFor("the edited content in the open pane", () =>
			app.diffPane.contextLines().includes(MOVED_BLOCK) ? true : null,
		);

		expect(app.review.composerDraft()).toEqual({
			text: "half a thought",
			range: "Comments on lines 1-1",
		});
	});

	it("pins the block the user sees, at the line numbers it moved to", async () => {
		const app = await setup({ repo: ONE_TRACKED_FILE });
		await app.repo.open();
		await app.review.openPanel();
		await app.openTrackedFile("watched");
		app.repo.writeWorkingTreeFile(WATCHED, AFTER);
		await app.events.externalChange(app.repo.path);
		const refreshed = await waitFor(
			"the edited content in the open pane",
			() => {
				const lines = app.diffPane.contextLines();
				return lines.includes(MOVED_BLOCK) ? lines : null;
			},
		);

		await app.review.selectLine(refreshed.indexOf(MOVED_BLOCK) + 1);
		await app.review.commentOnSelection();
		await app.review.write("the answer moved down a line");
		await app.review.submit();
		await app.review.openPanel();

		await waitFor("the thread", () =>
			app.review.threads().length > 0 ? true : null,
		);
		expect(app.review.threadExcerpt()).toEqual([MOVED_BLOCK]);
	});
});
