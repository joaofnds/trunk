import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** One markdown file with a real edit, so every diff view has lines or blocks
 *  to show and something above them to scroll. */
const EDITED_MARKDOWN: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "doc.md",
			content: "# Title\n\ndoomed paragraph\n\n## Section\n\nbody\n",
		},
		{ step: "commit", message: "base" },
		{
			step: "file",
			path: "doc.md",
			content: "# Title\n\n## Section\n\nbody\n\nfresh paragraph\n",
		},
	],
};

const DIFF_LINE = ".diff-line";
const RENDERED_BLOCK = ".rendered-diff .rendered-block";

async function openDoc() {
	const app = await setup({ repo: EDITED_MARKDOWN });
	await app.repo.open();
	await app.staging.open();
	await app.staging.openFile("doc.md");
	await waitFor("the plain diff of doc.md", () =>
		app.staging.addedLines().includes("fresh paragraph") ? true : null,
	);
	await app.settled();
	return app;
}

// Every diff view owns its scroller, and nothing above it may scroll on the
// same axis. Two vertical scroll containers above a line give the wheel two
// places to go: the inner one reaches its end, the scroll chains to the outer,
// and the pane slides up out of the window behind a second scrollbar
// (TRUNK-127). The assertion lists the scrollers so a failure names the extra
// one.
describe("the diff pane has exactly one vertical scroll container above its content", () => {
	afterEach(teardown);

	it("in the inline hunk view", async () => {
		const app = await openDoc();
		expect(app.diffPane.verticalScrollersAbove(DIFF_LINE)).toHaveLength(1);
	});

	it("in the inline full-file view", async () => {
		const app = await openDoc();
		await app.diffPane.showFullFile();
		await waitFor("the full file's lines", () =>
			app.staging.addedLines().includes("fresh paragraph") ? true : null,
		);
		await app.settled();
		expect(app.diffPane.verticalScrollersAbove(DIFF_LINE)).toHaveLength(1);
	});

	it("in the side-by-side view", async () => {
		const app = await openDoc();
		await app.diffPane.showSideBySide();
		await waitFor("the split view's lines", () =>
			document.querySelector(".split-cell") ? true : null,
		);
		await app.settled();
		expect(app.diffPane.verticalScrollersAbove(DIFF_LINE)).toHaveLength(1);
	});

	it("in the rendered markdown view", async () => {
		const app = await openDoc();
		await app.diffPane.showRendered();
		await waitFor("the rendered blocks", () =>
			app.diffPane.renderedAdded().length > 0 ? true : null,
		);
		await app.settled();
		expect(app.diffPane.verticalScrollersAbove(RENDERED_BLOCK)).toHaveLength(1);
	});
});
