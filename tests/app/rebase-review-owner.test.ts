import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/rebase.ts";
const ANCHOR = `${FILE}:L8-L8`;
const DRAFT = "keep this rebase comment on C3";
const ROOT_EDIT = "edited rebase root on C3";
const REPLY_EDIT = "edited rebase reply on C3";
const REPLY_DRAFT = "new rebase reply on C3";
const NOTE_DRAFT = "commit note on rebase C3";

const FOUR_VERSIONS: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(baseLines()) },
		{ step: "commit", message: "C1" },
		{
			step: "file",
			path: FILE,
			content: fileOf(changedLine(baseLines(), 2, "two changed")),
		},
		{ step: "commit", message: "C2" },
		{
			step: "file",
			path: FILE,
			content: fileOf(
				changedLine(
					changedLine(baseLines(), 2, "two changed"),
					8,
					"eight changed",
				),
			),
		},
		{ step: "commit", message: "C3" },
		{
			step: "file",
			path: FILE,
			content: fileOf(
				changedLine(
					changedLine(
						changedLine(baseLines(), 2, "two changed"),
						8,
						"eight changed",
					),
					1,
					"one changed",
				),
			),
		},
		{ step: "commit", message: "C4" },
	],
};

describe("an interactive-rebase diff comment", () => {
	afterEach(teardown);

	it("retains its text and target through hiding and reopening", async () => {
		const app = await setup({ repo: FOUR_VERSIONS });
		await app.repo.open();
		const commit = app.repo.shaOf("C3");
		await app.repo.contextMenu("C2");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.focus("C3");
		await app.rebaseEditor.openFile(FILE);
		await app.review.commentOnHunk(0);
		await app.review.write(DRAFT);
		expect(app.diffPane.contextLines()).not.toContain("one");
		await app.diffPane.showFullFile();
		await waitFor("the full rebase file payload", () =>
			app.diffPane.contextLines().includes("one") ? true : null,
		);

		await app.review.showReviewFilter(
			"none",
			() => app.review.composerDraft() === null,
		);
		await app.rebaseEditor.closeDiff();
		await app.rebaseEditor.focus("C2");
		await app.rebaseEditor.focus("C3");
		await app.review.showReviewFilter("all", () => true);
		await app.rebaseEditor.openFile(FILE);

		await expect(
			waitFor("the retained rebase comment", () => app.review.composerDraft()),
		).resolves.toEqual({
			text: DRAFT,
			range: "Comments on lines 8-8",
		});
		await app.review.submit();
		await app.rebaseEditor.cancel();
		await app.review.openPanel();
		await waitFor("the submitted rebase thread", () =>
			app.review.threads().length === 1 ? true : null,
		);
		await app.review.copyDoc();

		const doc = await waitFor(
			"the copied review document",
			() => app.clipboard.text,
		);
		expect(app.review.threads()).toEqual([ANCHOR]);
		expect(doc).toContain(`${ANCHOR} (${commit}, after) — open`);
		expect(doc).toContain(DRAFT);
	});

	it("retains note and thread editors on the focused rebase commit", async () => {
		const app = await setup({ repo: FOUR_VERSIONS });
		await app.repo.open();
		const commit = app.repo.shaOf("C3");
		await app.repo.contextMenu("C2");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.focus("C3");
		await app.rebaseEditor.openFile(FILE);
		await app.review.commentOnHunk(0);
		await app.review.write(DRAFT);
		await app.review.submit();
		await waitFor("the rebase thread", () =>
			app.review.threads().length === 1 ? true : null,
		);
		await app.review.dismissThread(ANCHOR);
		await app.review.showReviewFilter(
			"dismissed",
			() => app.review.states()[0] === "dismissed",
		);
		await app.rebaseEditor.closeDiff();
		await waitFor("the rebase commit-detail file badge", () =>
			app.repo.commitFileCommentBadge(FILE)?.count === 1 ? true : null,
		);
		expect(app.repo.commitFileCommentBadge(FILE)).toEqual({
			count: 1,
			tone: "dismissed",
		});
		await app.review.showReviewFilter(
			"none",
			() => app.repo.commitFileCommentBadge(FILE) === null,
		);
		await app.review.showReviewFilter(
			"dismissed",
			() => app.repo.commitFileCommentBadge(FILE)?.count === 1,
		);
		await app.review.showReviewFilter("all", () => true);
		await app.review.startCommitNote();
		await app.review.writeCommitNote("rebase commit root before editing");
		await app.review.saveCommitNote();
		await waitFor("the rebase commit note thread", () =>
			app.review.threads().length === 1 ? true : null,
		);
		await app.review.writeReply("reply before editing");
		await app.review.submitReply();
		await waitFor("the saved rebase reply", () =>
			app.review.replies().length === 1 ? true : null,
		);
		await app.review.startRootEdit();
		await app.review.writeRootEdit(ROOT_EDIT);
		await app.review.writeReply(REPLY_DRAFT);
		await app.review.startReplyEdit();
		await app.review.writeReplyEdit(REPLY_EDIT);
		await app.review.startCommitNote();
		await app.review.writeCommitNote(NOTE_DRAFT);

		await app.review.showReviewFilter(
			"none",
			() => app.review.rootEditDraft() === null,
		);
		await app.rebaseEditor.cancel();
		await app.repo.contextMenu("C2");
		app.contextMenu.choose("Interactive Rebase...");
		await app.rebaseEditor.focus("C3");
		await app.review.showReviewFilter("all", () => true);

		await expect(
			waitFor("the retained rebase root edit", () =>
				app.review.rootEditDraft(),
			),
		).resolves.toBe(ROOT_EDIT);
		expect(app.review.replyDraft()).toBe(REPLY_DRAFT);
		expect(app.review.replyEditDraft()).toBe(REPLY_EDIT);
		expect(app.review.commitNoteDraft()).toBe(NOTE_DRAFT);
		await app.review.saveReplyEdit();
		await app.review.saveRootEdit();
		await app.review.submitReply();
		await app.review.saveCommitNote();
		await app.rebaseEditor.cancel();
		await app.review.openPanel();
		await waitFor("the rebase note and thread", () =>
			app.review.threads().length === 3 ? true : null,
		);
		await app.review.copyDoc();

		const doc = await waitFor(
			"the copied rebase editor document",
			() => app.clipboard.text,
		);
		expect(doc).toContain(`${ANCHOR} (${commit}, after) — dismissed`);
		expect(doc).toContain(ROOT_EDIT);
		expect(doc).toContain(REPLY_EDIT);
		expect(doc).toContain(REPLY_DRAFT);
		expect(doc).toContain(NOTE_DRAFT);
	});
});

function fileOf(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function baseLines(): string[] {
	return [
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight",
		"nine",
	];
}

function changedLine(lines: string[], line: number, content: string): string[] {
	return lines.with(line - 1, content);
}
