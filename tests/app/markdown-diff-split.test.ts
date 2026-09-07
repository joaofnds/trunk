import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** One paragraph with one word rewritten, the shape of an edited rules file. */
const EDITED_PARAGRAPH: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "doc.md",
			content: "State a finding as fact. Put no headline in front of it.\n",
		},
		{ step: "commit", message: "base" },
		{
			step: "file",
			path: "doc.md",
			content: "State a finding as fact. Put no preamble in front of it.\n",
		},
	],
};

describe("the rendered markdown diff, side by side", () => {
	afterEach(teardown);

	// The reported defect: the inline view marked the edited words, while the
	// two columns of the same paragraph came up washed red and green whole.
	// Finding the edit meant reading both copies, through the wash.
	it("marks the changed words in each column and washes neither", async () => {
		const app = await setup({ repo: EDITED_PARAGRAPH });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("doc.md");
		await waitFor("the plain diff of doc.md", () =>
			app.staging.removedLines().length > 0 ? true : null,
		);
		await app.diffPane.showRendered();
		await app.diffPane.showSideBySide();

		const before = await waitFor("the before column's mark", () => {
			const marks = app.diffPane.renderedColumnMarks("before");
			return marks.length > 0 ? marks : null;
		});

		expect(before).toEqual(["headline"]);
		expect(app.diffPane.renderedColumnMarks("after")).toEqual(["preamble"]);
		expect(
			app.diffPane.renderedWashed(),
			"the prose reads on the pane background, not through a wash",
		).toHaveLength(0);
	});

	// TRUNK-144.4 AC #5: the hunk fold's per-gap note appeared only in the
	// inline view (`hunkMergedHtml`); the split columns (`hunkBeforeHtml` /
	// `hunkAfterHtml`) had no note at all. The backend embeds the note in every
	// folded fragment it produces, so this should fall out for both columns.
	it("shows a fold note in both columns, one per gap", async () => {
		const list = (third: string) =>
			Array.from({ length: 20 }, (_, i) =>
				i === 10 ? `- item ${i} ${third}` : `- item ${i}`,
			).join("\n");
		const app = await setup({
			repo: {
				steps: [
					{ step: "file", path: "doc.md", content: `${list("old")}\n` },
					{ step: "commit", message: "base" },
					{ step: "file", path: "doc.md", content: `${list("new")}\n` },
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
		await app.diffPane.showSideBySide();

		const notes = await waitFor("the split fold notes", () => {
			const found = app.diffPane.renderedFoldNotes();
			return found.length > 0 ? found : null;
		});
		// One gap above the window, one below, on EACH column: four notes total.
		expect(notes).toEqual([
			"7 items hidden",
			"6 items hidden",
			"7 items hidden",
			"6 items hidden",
		]);
	});
});
