import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/untouched.ts";
const REPOSITORY: RepoSpec = {
	steps: [
		{
			step: "file",
			path: FILE,
			content: "const answer = 42;\nexport { answer };\n",
		},
		{ step: "file", path: "other.txt", content: "unrelated\n" },
		{ step: "commit", message: "Add files" },
	],
};

describe("a current-file comment filtered out before autosave", () => {
	afterEach(teardown);

	it("retains its text and line target through leaving and reopening", async () => {
		const app = await setup({ repo: REPOSITORY });
		await openCurrentFile(app);
		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("name this constant");

		await app.review.showReviewFilter(
			"none",
			() => app.review.composerDraft() === null,
		);
		await app.review.openPanel();
		await app.review.showReviewFilter("all", () => !app.review.finderVisible());
		await openCurrentFileFromPanel(app);

		expect(app.review.composerDraft()).toEqual({
			text: "name this constant",
			range: "Comments on lines 1-1",
		});
		await app.review.submit();
		await app.review.openPanel();
		const threads = await waitFor("the current-file thread", () => {
			const visible = app.review.threads();
			return visible.length === 1 ? visible : null;
		});

		expect(threads).toEqual([`${FILE}:L1-L1`]);
		await app.review.copyDoc();
		const doc = await waitFor(
			"the copied current-file review",
			() => app.clipboard.text,
		);
		expect(doc).toContain(`${FILE}:L1-L1`);
		expect(doc).toContain("name this constant");
	});

	it("finishes an accepted submission while hiding threads removes its editor", async () => {
		const app = await setup({ repo: REPOSITORY });
		await openCurrentFile(app);
		await app.review.selectLine(2);
		await app.review.commentOnSelection();
		await app.review.write("seed the active review");
		await app.review.submit();
		await app.review.openPanel();
		await waitFor("the active review seed", () =>
			app.review.threads().length === 1 ? true : null,
		);
		await openCurrentFileFromPanel(app);
		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("finish this hidden write");
		const release = app.holdCommand("add_current_file_thread");
		await app.review.submit();
		await waitFor("the accepted current-file write", () =>
			app.invokes().some(({ cmd }) => cmd === "add_current_file_thread")
				? true
				: null,
		);

		await app.review.showReviewFilter(
			"none",
			() => app.review.composerDraft() === null,
		);
		await app.review.showReviewFilter("all", () => true);
		await app.review.openPanel();
		await openFileFromPanel(app, "other");
		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("keep this replacement draft");

		release();
		await app.settled();
		expect(app.review.composerDraft()).toEqual({
			text: "keep this replacement draft",
			range: "Comments on lines 1-1",
		});
		await app.review.openPanel();
		const threads = await waitFor("the submitted current-file thread", () => {
			const visible = app.review.threads();
			return visible.length === 2 ? visible : null;
		});

		expect(threads).toEqual([`${FILE}:L1-L1`, `${FILE}:L2-L2`]);
	});

	it("shows a resolved current-file thread only in its explicit finder bucket", async () => {
		const app = await setup({ repo: REPOSITORY });
		await openCurrentFile(app);
		await app.review.selectLine(1);
		await app.review.commentOnSelection();
		await app.review.write("resolved current-file note");
		await app.review.submit();
		await app.review.openPanel();
		await waitFor("the current-file thread", () =>
			app.review.threads().length === 1 ? true : null,
		);
		await app.review.markDone();
		await waitFor("the done current-file thread", () =>
			app.review.states()[0] === "done" ? true : null,
		);
		await app.review.openFileFinder();
		await app.review.findFile("untouched");
		await waitFor("the resolved file with no default badge", () =>
			app.review.finderRows().length === 1 && app.review.finderBadge() === null
				? true
				: null,
		);

		await app.review.showReviewFilter(
			"done",
			() => app.review.finderBadge()?.count === 1,
		);

		expect(app.review.finderBadge()).toEqual({
			count: 1,
			background: "var(--color-thread-done)",
		});
	});
});

type RunningApp = Awaited<ReturnType<typeof setup>>;

async function openCurrentFile(app: RunningApp): Promise<void> {
	await app.repo.open();
	await app.review.openPanel();
	await openCurrentFileFromPanel(app);
}

async function openCurrentFileFromPanel(app: RunningApp): Promise<void> {
	await openFileFromPanel(app, "untouched");
}

async function openFileFromPanel(
	app: RunningApp,
	query: string,
): Promise<void> {
	await app.review.openFileFinder();
	await app.review.findFile(query);
	await waitFor(`the ${query} file in the finder`, () =>
		app.review.finderRows().length === 1 ? true : null,
	);
	await app.review.openTopFinderRow();
	await waitFor("the current-file contents", () =>
		app.diffPane.contextLines().length > 0 ? true : null,
	);
}
