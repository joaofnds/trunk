import { flushSync } from "svelte";
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

/** Two commits that both touch markdown, so a rendered diff between them is a
 *  commit-to-commit diff: two fixed revs. A second file gives the reader
 *  somewhere else to go without leaving the commit. */
const TWO_MARKDOWN_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: "doc.md", content: "# Title\n\nfirst paragraph\n" },
		{ step: "file", path: "other.md", content: "# Other\n\nother first\n" },
		{ step: "commit", message: "base" },
		{
			step: "file",
			path: "doc.md",
			content: "# Title\n\nfirst paragraph\n\nsecond paragraph\n",
		},
		{
			step: "file",
			path: "other.md",
			content: "# Other\n\nother first\n\nother second\n",
		},
		{ step: "commit", message: "edit the doc" },
	],
};

/** A markdown file renamed in its second commit with one paragraph edited,
 *  the shape of a moved rules file. The file list already pairs the rename;
 *  the rendered view must read the before side from the old name. */
const RENAMED_MARKDOWN: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "old.md",
			content:
				"# Title\n\nfirst paragraph\n\nsecond paragraph\n\nthird paragraph\n",
		},
		{ step: "commit", message: "base" },
		{ step: "removeFile", path: "old.md" },
		{
			step: "file",
			path: "new.md",
			content:
				"# Title\n\nfirst paragraph\n\nsecond paragraph\n\nchanged third paragraph\n",
		},
		{ step: "commit", message: "move the doc" },
	],
};

/** Three commits: A renames nothing, B renames doc.md to new.md, C edits
 *  new.md. Comparing base A to target C pairs the rename across the whole
 *  range; the before side must read at A, where doc.md still holds its
 *  original content, not at C's parent B, where doc.md is already gone
 *  (TRUNK-163). */
const RENAMED_THEN_EDITED_ACROSS_COMPARE: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "doc.md",
			content: "# Title\n\nfirst paragraph\n\nsecond paragraph\n",
		},
		{ step: "commit", message: "A: add the doc" },
		{ step: "removeFile", path: "doc.md" },
		{
			step: "file",
			path: "new.md",
			content: "# Title\n\nfirst paragraph\n\nsecond paragraph\n",
		},
		{ step: "commit", message: "B: rename the doc" },
		{
			step: "file",
			path: "new.md",
			content: "# Title\n\nfirst paragraph\n\nchanged second paragraph\n",
		},
		{ step: "commit", message: "C: edit the doc" },
	],
};

/** Same shape as above but with no edit at C: the rename is the only change in
 *  the range. Every block must render unchanged, not just the untouched ones. */
const RENAMED_ONLY_ACROSS_COMPARE: RepoSpec = {
	steps: [
		{
			step: "file",
			path: "doc.md",
			content: "# Title\n\nfirst paragraph\n\nsecond paragraph\n",
		},
		{ step: "commit", message: "A: add the doc" },
		{ step: "removeFile", path: "doc.md" },
		{
			step: "file",
			path: "new.md",
			content: "# Title\n\nfirst paragraph\n\nsecond paragraph\n",
		},
		{ step: "commit", message: "B: rename the doc" },
		{ step: "file", path: "unrelated.md", content: "# Unrelated\n" },
		{ step: "commit", message: "C: unrelated change" },
	],
};

/** How many times the rendered view has asked the backend for a diff. The
 *  count, not the content, is what says whether a refetch happened. */
function renders(app: { invokes(): readonly { cmd: string }[] }): number {
	return app.invokes().filter(({ cmd }) => cmd === "render_markdown_diff")
		.length;
}

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
		// One-line items, so the default 3-line context window reaches three
		// whole neighbours each side of the change — not all twenty. The
		// changed item reads "old new": the merged copy carries the del and the
		// ins together, which is the whole point of the inline view.
		expect(items).toEqual([
			"item 7",
			"item 8",
			"item 9",
			"item 10 old new",
			"item 11",
			"item 12",
			"item 13",
		]);
		expect(app.diffPane.renderedFoldNotes()).toEqual(["13 items hidden"]);

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

	// A list inside a blockquote had no leaves, so it never folded: a long
	// quoted list rendered whole while the identical unquoted one folded to a
	// few items (TRUNK-103). The quote must fold and keep the changed item.
	it("folds a long list inside a blockquote", async () => {
		const doc = (ninth: string) =>
			Array.from({ length: 20 }, (_, i) =>
				i === 9 ? `> - item ${ninth}` : `> - item ${i}`,
			).join("\n");
		const app = await setup({
			repo: {
				steps: [
					{ step: "file", path: "doc.md", content: `${doc("nine")}\n` },
					{ step: "commit", message: "base" },
					{ step: "file", path: "doc.md", content: `${doc("NINE")}\n` },
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

		const items = await waitFor("the rendered quote", () => {
			const rendered = app.diffPane.renderedListItems();
			return rendered.length > 0 ? rendered : null;
		});
		expect(items.length).toBeLessThan(20);
		// The merged copy shows the word that left beside the one that arrived.
		expect(items.join(" ")).toContain("NINE");
		expect(app.diffPane.renderedWordAdded()).toEqual(["NINE"]);
		expect(app.diffPane.renderedFoldNotes().length).toBeGreaterThan(0);

		// And the whole quote is there when the reader asks for it.
		await app.diffPane.showFullFile();
		const full = await waitFor("the unfolded quote", () => {
			const rendered = app.diffPane.renderedListItems();
			return rendered.length === 20 ? rendered : null;
		});
		expect(full[9]).toContain("NINE");
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

	// TRUNK-162: a renamed and edited file rendered as one all-green document,
	// because the before side was read under the new name, where nothing
	// existed at the parent.
	it("shows a renamed file's edit against its old content, not as all added", async () => {
		const app = await setup({ repo: RENAMED_MARKDOWN });
		await app.repo.open();
		await app.repo.selectCommit("move the doc");
		await app.repo.openCommitFile("new.md");
		await app.settled();
		await app.diffPane.showRendered();
		await app.diffPane.showFullFile();

		const unchanged = await waitFor("the untouched rendered blocks", () => {
			const blocks = app.diffPane.renderedUnchanged();
			return blocks.includes("second paragraph") ? blocks : null;
		});

		expect(unchanged).toEqual(["Title", "first paragraph", "second paragraph"]);
		expect(app.diffPane.renderedWordAdded()).toEqual(["changed"]);
		expect(app.diffPane.renderedAdded()).toEqual([]);
	});

	// TRUNK-163: comparing base A to target C, where the rename happened at B in
	// between, read the before side at C's parent (B) instead of the compare
	// base (A). At B the old path is already gone, so every block rendered
	// added.
	it("shows a compared file's untouched content unchanged across a rename earlier in the range", async () => {
		const app = await setup({ repo: RENAMED_THEN_EDITED_ACROSS_COMPARE });
		await app.repo.open();
		await app.repo.selectCompare("A: add the doc", "C: edit the doc");
		await app.repo.openCompareFile("new.md");
		await app.settled();
		await app.diffPane.showRendered();
		await app.diffPane.showFullFile();

		const unchanged = await waitFor("the untouched rendered blocks", () => {
			const blocks = app.diffPane.renderedUnchanged();
			return blocks.includes("first paragraph") ? blocks : null;
		});

		expect(unchanged).toEqual(["Title", "first paragraph"]);
		expect(app.diffPane.renderedAdded()).toEqual([]);
	});

	it("shows every block unchanged when a rename is the only change across the compared range", async () => {
		const app = await setup({ repo: RENAMED_ONLY_ACROSS_COMPARE });
		await app.repo.open();
		await app.repo.selectCompare("A: add the doc", "C: unrelated change");
		await app.repo.openCompareFile("new.md");
		await app.settled();
		await app.diffPane.showRendered();
		await app.diffPane.showFullFile();

		const unchanged = await waitFor("the untouched rendered blocks", () => {
			const blocks = app.diffPane.renderedUnchanged();
			return blocks.includes("second paragraph") ? blocks : null;
		});

		expect(unchanged).toEqual(["Title", "first paragraph", "second paragraph"]);
		expect(app.diffPane.renderedAdded()).toEqual([]);
	});

	it("keeps its blocks on screen while a repo-change refetch is in flight", async () => {
		const app = await setup({ repo: EDITED_MARKDOWN });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("doc.md");
		await waitFor("the plain diff of doc.md", () =>
			app.staging.addedLines().includes("fresh paragraph") ? true : null,
		);
		await app.diffPane.showRendered();
		await waitFor("the green rendered block", () =>
			app.diffPane.renderedAdded().length > 0 ? true : null,
		);
		await app.settled();

		await app.events.externalChange(app.repo.path);
		await app.elapse();
		flushSync();

		// The refetch's reply needs a host round trip, which has not happened
		// yet: this is the pane mid-refetch. A pane that empties here collapses
		// its scroller, and WebKit clamps the scroll position to the top.
		expect(app.diffPane.renderedAdded()).toEqual(["fresh paragraph"]);
		expect(app.diffPane.renderedRemoved()).toEqual(["doomed paragraph"]);
	});

	it("issues no refetch on a repo change when both revs are commits", async () => {
		const app = await setup({ repo: TWO_MARKDOWN_COMMITS });
		await app.repo.open();
		await app.repo.selectCommit("edit the doc");
		await app.repo.openCommitFile("doc.md");
		await app.settled();
		await app.diffPane.showRendered();
		await waitFor("the green rendered block", () =>
			app.diffPane.renderedAdded().length > 0 ? true : null,
		);
		await app.settled();
		const before = renders(app);

		await app.events.externalChange(app.repo.path);
		await app.elapse();
		await app.settled();

		// Two fixed revs: nothing written to the repo can change this diff, so
		// the round trip the working-tree kinds need is waste here.
		expect(renders(app)).toBe(before);
		expect(app.diffPane.renderedAdded()).toEqual(["second paragraph"]);
	});

	it("still refetches a commit diff when the reader opens another file", async () => {
		const app = await setup({ repo: TWO_MARKDOWN_COMMITS });
		await app.repo.open();
		await app.repo.selectCommit("edit the doc");
		await app.repo.openCommitFile("doc.md");
		// Let the panel's stored view preferences land first: they arrive
		// asynchronously and would otherwise overwrite the toggle underneath.
		await app.settled();
		await app.diffPane.showRendered();
		await waitFor("the green rendered block", () =>
			app.diffPane.renderedAdded().length > 0 ? true : null,
		);
		await app.settled();

		await app.repo.openCommitFile("other.md");

		// The revs are fixed; the file is not. Skipping this fetch would leave
		// the reader looking at the previous file's diff.
		await expect(
			waitFor("the other file's rendered block", () => {
				const blocks = app.diffPane.renderedAdded();
				return blocks.includes("other second") ? blocks : null;
			}),
		).resolves.toEqual(["other second"]);
	});

	it("still refetches an unstaged diff on a repo change", async () => {
		const app = await setup({ repo: EDITED_MARKDOWN });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("doc.md");
		await waitFor("the plain diff of doc.md", () =>
			app.staging.addedLines().includes("fresh paragraph") ? true : null,
		);
		await app.diffPane.showRendered();
		await waitFor("the green rendered block", () =>
			app.diffPane.renderedAdded().length > 0 ? true : null,
		);
		await app.settled();
		const before = renders(app);

		await app.events.externalChange(app.repo.path);
		await app.elapse();
		await app.settled();

		// The working tree is what changed on disk, so this diff can differ from
		// what is on screen and has to be re-read.
		expect(renders(app)).toBeGreaterThan(before);
	});
});
