import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/full-file.ts";
const LINES = Array.from({ length: 9 }, (_, at) => `line ${at + 1}`);
const REPOSITORY: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(LINES) },
		{ step: "commit", message: "Add full file" },
		{
			step: "file",
			path: FILE,
			content: fileOf(LINES.with(1, "line 2 changed")),
		},
		{ step: "commit", message: "Change full file" },
	],
};

describe("a full-file comment on a commit", () => {
	afterEach(teardown);

	it("retains its text and captured range through hiding and reopening", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		const commit = app.repo.shaOf("Change full file");
		await app.repo.selectCommit("Change full file");
		await app.repo.openCommitFile(FILE);
		await app.review.commentOnHunk(0);
		await app.review.write("seed the review");
		await app.review.submit();
		await app.review.openPanel();
		await waitFor("the seed thread", () =>
			app.review.threads().length === 1 ? true : null,
		);
		await app.review.jumpToThread();
		await app.diffPane.showFullFile();
		await app.diffPane.showFullFile();
		await waitFor("the whole commit file", () =>
			app.diffPane.contextLines().includes("line 9") ? true : null,
		);
		await app.review.selectNewLine(8);
		await app.review.commentOnSelection();
		await app.review.write("keep this full-file target");

		await app.review.showReviewFilter(
			"none",
			() => app.review.composerDraft() === null,
		);
		await app.review.openPanel();
		await app.review.showReviewFilter(
			"all",
			() => app.review.threads().length === 1,
		);
		await app.review.jumpToThread();

		await expect(
			waitFor("the retained full-file comment", () =>
				app.review.composerDraft(),
			),
		).resolves.toEqual({
			text: "keep this full-file target",
			range: "Comments on lines 8-8",
		});
		await app.review.submit();
		await app.review.openPanel();
		await waitFor("both commit threads", () =>
			app.review.threads().length === 2 ? true : null,
		);
		await app.review.copyDoc();

		const doc = await waitFor(
			"the copied full-file review",
			() => app.clipboard.text,
		);
		expect(doc).toContain(`${FILE}:L8-L8 (${commit}, after) — open`);
		expect(doc).toContain("keep this full-file target");
	});
});

function fileOf(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}
