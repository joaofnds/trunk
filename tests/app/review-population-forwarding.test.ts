import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const COMMIT_FILE = "src/commit.ts";
const STAGED_FILE = "staged.ts";
const UNSTAGED_FILES = ["src/dir/a.ts", "src/dir/b.ts"];
const REPOSITORY: RepoSpec = {
	steps: [
		{ step: "file", path: COMMIT_FILE, content: "export const commit = 1;\n" },
		{ step: "file", path: STAGED_FILE, content: "export const staged = 1;\n" },
		...UNSTAGED_FILES.map((path) => ({
			step: "file" as const,
			path,
			content: "export const value = 1;\n",
		})),
		{ step: "commit", message: "Base" },
		{ step: "file", path: COMMIT_FILE, content: "export const commit = 2;\n" },
		{ step: "commit", message: "Change commit" },
		{ step: "file", path: STAGED_FILE, content: "export const staged = 2;\n" },
		...UNSTAGED_FILES.map((path, index) => ({
			step: "file" as const,
			path,
			content: `export const value = ${index + 2};\n`,
		})),
	],
};

describe("review population forwarding", () => {
	afterEach(teardown);

	it("forwards a filtered population through graph, staging, directory, toolbar, and commit detail", async () => {
		const app = await setup({ repo: REPOSITORY });
		await app.repo.open();
		await app.staging.open();
		await app.staging.stageFile(STAGED_FILE);
		await app.settled();

		await app.staging.openStagedFile(STAGED_FILE);
		await addDismissedHunkComment(
			app,
			`${STAGED_FILE}:L1-L1`,
			"dismissed staged comment",
		);
		await app.staging.open();
		await app.staging.openFile(UNSTAGED_FILES[0]);
		await addDismissedHunkComment(
			app,
			`${UNSTAGED_FILES[0]}:L1-L1`,
			"dismissed unstaged comment",
		);
		await app.repo.selectCommit("Change commit");
		await app.repo.openCommitFile(COMMIT_FILE);
		await addDismissedHunkComment(
			app,
			`${COMMIT_FILE}:L1-L1`,
			"dismissed commit comment",
		);
		await app.review.showReviewFilter(
			"dismissed",
			() =>
				app.repo.workingTreeCommentBadge()?.count === 2 &&
				app.repo.commitCommentBadge("Change commit")?.count === 1 &&
				app.review.reviewBadgeCount() === 3,
		);
		expect(app.repo.workingTreeCommentBadge()).toEqual({
			count: 2,
			tone: "dismissed",
		});
		expect(app.repo.commitCommentBadge("Change commit")).toEqual({
			count: 1,
			tone: "dismissed",
		});
		expect(app.review.reviewBadgeTone()).toBe("dismissed");
		expect(app.repo.commitFileCommentBadge(COMMIT_FILE)).toEqual({
			count: 1,
			tone: "dismissed",
		});
		await app.repo.openCommitFile(COMMIT_FILE);
		await waitFor("the current-view toolbar count", () =>
			app.review.viewBadgeCount() === 1 ? true : null,
		);
		expect(app.review.viewBadgeTone()).toBe("dismissed");
		await app.review.showReviewFilter(
			"none",
			() =>
				app.review.viewBadgeCount() === null &&
				app.review.reviewBadgeCount() === null,
		);
		await app.review.showReviewFilter(
			"dismissed",
			() =>
				app.review.viewBadgeCount() === 1 &&
				app.review.reviewBadgeCount() === 3,
		);
		await app.diffPane.close();

		await app.staging.open();
		await app.staging.switchToTreeView();
		await waitFor("the staging review counts", () =>
			app.staging.unstagedDirectoryCommentBadge("src/dir")?.count === 1 &&
			app.staging.stagedFileCommentBadge(STAGED_FILE)?.count === 1
				? true
				: null,
		);
		expect(app.staging.unstagedDirectoryCommentBadge("src/dir")).toEqual({
			count: 1,
			tone: "dismissed",
		});
		expect(app.staging.stagedFileCommentBadge(STAGED_FILE)).toEqual({
			count: 1,
			tone: "dismissed",
		});

		await app.review.showReviewFilter(
			"none",
			() =>
				app.repo.workingTreeCommentBadge() === null &&
				app.repo.commitCommentBadge("Change commit") === null &&
				app.staging.unstagedDirectoryCommentBadge("src/dir") === null &&
				app.staging.stagedFileCommentBadge(STAGED_FILE) === null &&
				app.review.reviewBadgeCount() === null,
		);
		await app.review.showReviewFilter(
			"dismissed",
			() =>
				app.repo.workingTreeCommentBadge()?.count === 2 &&
				app.repo.commitCommentBadge("Change commit")?.count === 1 &&
				app.staging.unstagedDirectoryCommentBadge("src/dir")?.count === 1 &&
				app.staging.stagedFileCommentBadge(STAGED_FILE)?.count === 1 &&
				app.review.reviewBadgeCount() === 3,
		);
	});
});

type RunningApp = Awaited<ReturnType<typeof setup>>;

async function addHunkComment(app: RunningApp, text: string): Promise<void> {
	await app.review.commentOnHunk(0);
	await app.review.write(text);
	await app.review.submit();
	await waitFor("the submitted composer to close", () =>
		app.review.composerDraft() === null ? true : null,
	);
	await app.diffPane.close();
}

async function addDismissedHunkComment(
	app: RunningApp,
	fileRef: string,
	text: string,
): Promise<void> {
	await addHunkComment(app, text);
	await app.review.openPanel();
	await app.review.dismissThread(fileRef);
	await app.review.closePanel();
}
