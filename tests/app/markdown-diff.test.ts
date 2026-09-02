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
		expect(
			app.diffPane.renderedWashed().length,
			"no block keeps the full wash",
		).toBe(0);
	});

	// TRUNK-93, the reported defect: a rules document whose body is one long
	// list showed every item in hunk mode when a single item had changed. The
	// pane opens in hunk mode, so this is the default reading of such a file.
	it("hides a long list's unchanged items in hunk mode, and shows them all in full mode", async () => {
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

		const items = await waitFor("the rendered list", () => {
			const rendered = app.diffPane.renderedListItems();
			return rendered.length > 0 ? rendered : null;
		});
		// The changed item plus one neighbour each side — not all twenty. The
		// changed item reads "old new": the merged copy carries the del and the
		// ins together, which is the whole point of the inline view.
		expect(items).toEqual(["item 9", "item 10 old new", "item 11"]);
		expect(app.diffPane.renderedFoldNotes()).toEqual(["17 items hidden"]);

		await app.diffPane.showFullFile();

		await expect(
			waitFor("the full list", () => {
				const rendered = app.diffPane.renderedListItems();
				return rendered.length === 20 ? rendered : null;
			}),
		).resolves.toContain("item 0");
		expect(app.diffPane.renderedFoldNotes()).toEqual([]);
	});

	// A markup-only edit inside one list item: the leaf signature is visible
	// text, so every leaf compares equal. The item that changed must still be
	// tinted, or the reader sees a plain list indistinguishable from an
	// unchanged one (TRUNK-101), and the fold must keep that item — hiding all
	// three once left an empty list.
	it("tints the one item of a list whose only edit is markup", async () => {
		const doc = (emphasis: string) =>
			[
				"1. plain step one",
				"2. plain step two",
				`3. compare against ${emphasis}the stored baseline${emphasis} first`,
			].join("\n");
		const app = await setup({
			repo: {
				steps: [
					{ step: "file", path: "doc.md", content: `${doc("**")}\n` },
					{ step: "commit", message: "base" },
					{ step: "file", path: "doc.md", content: `${doc("")}\n` },
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

		const items = await waitFor("the rendered list", () => {
			const rendered = app.diffPane.renderedListItems();
			return rendered.length > 0 ? rendered : null;
		});
		// The default (hunk) view folds the distant unchanged item away; what
		// must survive is the changed one, tinted.
		expect(items.length).toBeGreaterThan(0);
		expect(items[items.length - 1]).toContain("the stored baseline");

		const tinted = await waitFor("the tinted item", () => {
			const added = app.diffPane.renderedAdded();
			return added.length > 0 ? added : null;
		});
		expect(tinted).toHaveLength(1);
		expect(tinted[0]).toContain("the stored baseline");
		// No visible word changed, so nothing is struck or inserted.
		expect(app.diffPane.renderedWordDeleted()).toEqual([]);
		expect(app.diffPane.renderedWordAdded()).toEqual([]);

		// The whole list is there when the reader asks for it.
		await app.diffPane.showFullFile();
		const full = await waitFor("the unfolded list", () => {
			const rendered = app.diffPane.renderedListItems();
			return rendered.length === 3 ? rendered : null;
		});
		expect(full[2]).toContain("the stored baseline");
	});

	// A reflow moves the source lines without changing one rendered word, so
	// the block has nothing to tint. Without a note it draws as an untinted
	// paragraph the reader cannot tell from an unchanged one.
	it("says a rewrapped paragraph renders identically", async () => {
		const app = await setup({
			repo: {
				steps: [
					{
						step: "file",
						path: "doc.md",
						content:
							"State a finding as fact. No headline in front of it,\nand no account of how or when you found it.\n",
					},
					{ step: "commit", message: "base" },
					{
						step: "file",
						path: "doc.md",
						content:
							"State a finding as fact. No headline in\nfront of it, and no account of how or when\nyou found it.\n",
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

		await expect(
			waitFor("the reflow note", () => {
				const notes = app.diffPane.renderedFoldNotes();
				return notes.length > 0 ? notes : null;
			}),
		).resolves.toEqual(["Reflowed — renders identically"]);
	});

	it("shows one merged copy per changed list, with no style to choose", async () => {
		const app = await setup({
			repo: {
				steps: [
					{
						step: "file",
						path: "doc.md",
						content: "- keep one\n- old third here\n- keep two\n",
					},
					{ step: "commit", message: "base" },
					{
						step: "file",
						path: "doc.md",
						content: "- keep one\n- new third here\n- keep two\n",
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

		const dels = await waitFor("the merged del mark", () => {
			const texts = app.diffPane.renderedWordDeleted();
			return texts.length > 0 ? texts : null;
		});
		expect(dels).toEqual(["old"]);
		expect(app.diffPane.renderedWordAdded()).toEqual(["new"]);
		expect(app.diffPane.renderedRemoved()).toEqual([]);
		expect(app.diffPane.renderedAdded()).toEqual([]);
	});
});
