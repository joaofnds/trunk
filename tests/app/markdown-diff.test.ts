import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** A paragraph deleted at the top and another added at the bottom, kept content
 *  between them, so neither pairs into a word-level change: the rendered view
 *  must show one whole red block and one whole green one. */
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

describe("the rendered markdown diff", () => {
	afterEach(teardown);

	it("renders the changed paragraphs on the sides the plain diff shows", async () => {
		const app = await setup({ repo: EDITED_MARKDOWN });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("doc.md");
		await waitFor("the plain diff of doc.md", () =>
			app.staging.addedLines().includes("fresh paragraph") ? true : null,
		);
		expect(app.staging.removedLines()).toContain("doomed paragraph");

		await app.diffPane.showRendered();

		await expect(
			waitFor("the green rendered block", () => {
				const blocks = app.diffPane.renderedAdded();
				return blocks.length > 0 ? blocks : null;
			}),
		).resolves.toEqual(["fresh paragraph"]);
		expect(app.diffPane.renderedRemoved()).toEqual(["doomed paragraph"]);
	});

	it("marks a clause removed from a bullet inside the item, with no wash", async () => {
		const app = await setup({
			repo: {
				steps: [
					{
						step: "file",
						path: "doc.md",
						content:
							"- On conflict, the specific rule governs. The repo's own file wins over this skill. A language file wins over this core file.\n- Resolve conflicts out loud.\n",
					},
					{ step: "commit", message: "base" },
					{
						step: "file",
						path: "doc.md",
						content:
							"- On conflict, the specific rule governs. A language file wins over this core file.\n- Resolve conflicts out loud.\n",
					},
				],
			},
		});
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("doc.md");
		await waitFor("the plain diff of doc.md", () =>
			app.staging.removedLines().length > 0 ? true : null,
		);
		await app.diffPane.showRendered();

		const marks = await waitFor("the del word mark", () => {
			const texts = app.diffPane.renderedWordDeleted();
			return texts.length > 0 ? texts : null;
		});

		expect(marks.join(" ")).toContain("repo's own file wins over this skill");
		const washed = document.querySelectorAll(
			".rendered-diff .md-removed:not(.no-wash), .rendered-diff .md-added:not(.no-wash)",
		);
		expect(washed.length, "no block keeps the full wash").toBe(0);
	});
});
