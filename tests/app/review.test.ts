import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

type RunningApp = Awaited<ReturnType<typeof setup>>;

const FILE = "src/main.ts";
/** How the panel writes an anchored thread's file reference. */
const ANCHOR = `${FILE}:L3-L3`;
const COMMENT = "this line needs a look";

const NUMBERED = Array.from({ length: 24 }, (_, at) => `line ${at + 1}`);

/** One line rewritten near the top: a single hunk, so commenting the hunk with
 *  no line selection is unambiguous. */
const TWO_COMMITS: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: fileOf(NUMBERED) },
		{ step: "commit", message: "Add main" },
		{
			step: "file",
			path: FILE,
			content: fileOf(NUMBERED.with(2, "line 3 CHANGED")),
		},
		{ step: "commit", message: "Change main" },
	],
};

describe("a comment left on a commit's diff", () => {
	afterEach(teardown);

	it("becomes a thread the panel offers to resolve", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);

		expect(app.review.actions()).toEqual([
			"Dismiss",
			"Mark done",
			"Edit comment",
			"Delete comment",
		]);
		expect(app.review.threads()).toEqual([ANCHOR]);
		expect(app.review.states()).toEqual(["open"]);
	});

	it("holds a comment until its batch is sent", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await app.repo.open();
		await app.repo.selectCommit("Change main");
		await app.repo.openCommitFile(FILE);
		await app.review.commentOnHunk(0);
		await app.review.write(COMMENT);
		await app.review.holdInBatch();
		await app.review.openPanel();
		await waitFor("the held comment's Pending mark", () =>
			app.review.pendingCount() === 1 ? true : null,
		);
		expect(app.review.sendLabel()).toBe("Send 1");

		await app.review.send();

		expect(app.review.pendingCount()).toBe(0);
		expect(app.review.threads()).toEqual([ANCHOR]);
	});

	it("copies a completed thread while the panel shows it", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);
		await app.review.markDone();
		await waitFor("the thread to reach done", () =>
			app.review.states()[0] === "done" ? true : null,
		);
		await app.review.pickPreset(
			"settled",
			() => app.review.threads().length === 1,
		);

		await app.review.copyDoc();

		const doc = await waitFor(
			"the copied review document",
			() => app.clipboard.text,
		);
		expect(doc).toContain(ANCHOR);
		expect(doc).toContain(COMMENT);
	});

	it("shows every thread again from the header's Show all", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);
		await app.review.pickPreset(
			"settled",
			() => app.review.threads().length === 0,
		);

		await app.review.showAll();

		await waitFor("the open thread to come back", () =>
			app.review.threads().length === 1 ? true : null,
		);
		expect(app.review.preset()).toBe("all");
	});

	it.each([
		[
			"hiding every thread",
			(app: RunningApp, observe: () => boolean) =>
				app.review.hideThreads(observe),
		],
		[
			"the Settled preset",
			(app: RunningApp, observe: () => boolean) =>
				app.review.pickPreset("settled", observe),
		],
	] as const)(
		"leaves nothing to copy when %s leaves no thread shown",
		async (_name, gesture) => {
			const app = await setup({ repo: TWO_COMMITS });
			await createReviewThread(app);

			await gesture(app, () => app.review.threads().length === 0);

			expect(app.review.copyState()).toBe("disabled");
		},
	);

	it("retains an unsaved diff comment and its range through hiding and leaving the diff", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		const commit = await createReviewThread(app);
		await app.review.jumpToThread();
		await app.review.commentOnHunk(0);
		await app.review.write("keep this unsaved comment");

		await app.review.hideThreads(() => app.review.composerDraft() === null);
		await app.review.openPanel();
		await app.review.showThreads(() => app.review.threads().length === 1);
		await app.review.jumpToThread();

		const restored = await waitFor("the retained diff comment", () =>
			app.review.composerDraft(),
		);
		expect(restored).toEqual({
			text: "keep this unsaved comment",
			range: "Comment on line 3",
		});
		await app.review.submit();
		await app.review.openPanel();
		await waitFor("both submitted threads", () =>
			app.review.threads().length === 2 ? true : null,
		);
		await app.review.copyDoc();
		const doc = await waitFor(
			"the copied review doc",
			() => app.clipboard.text,
		);
		expect(doc).toContain(`${ANCHOR} (${commit}, after) — open`);
		expect(doc).toContain("keep this unsaved comment");
	});

	it("names the review a new diff comment lands in", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);
		const active = await app.review.newReview();
		await app.review.closePanel();

		await app.review.commentOnHunk(0);

		const landing = await waitFor("the composer's landing review", () =>
			app.review.composerLanding(),
		);
		expect(landing).toContain(`Lands in ${active}`);
	});

	it("keeps panel and inline reply drafts separate through hiding and remounting", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);
		await app.review.writeReply("panel reply in progress");
		await app.review.jumpToThread();
		await app.review.writeReply("inline reply in progress");

		await app.review.hideThreads(() => app.review.threads().length === 0);
		await app.review.openPanel();
		await app.review.showThreads(() => app.review.threads().length === 1);
		const panelReply = await waitFor("the panel reply", () =>
			app.review.replyDraft(),
		);
		expect(panelReply).toBe("panel reply in progress");
		await app.review.submitReply();
		await waitFor("the saved panel reply", () =>
			app.review.replies().includes("panel reply in progress") ? true : null,
		);
		await app.review.jumpToThread();
		const inlineReply = await waitFor("the inline reply", () =>
			app.review.replyDraft(),
		);

		expect(inlineReply).toBe("inline reply in progress");
		await app.review.submitReply();
		const replies = await waitFor("both replies on the original thread", () => {
			const showing = app.review.replies();
			return showing.length === 2 ? showing : null;
		});
		expect(replies).toEqual([
			"panel reply in progress",
			"inline reply in progress",
		]);
	});
});

async function createReviewThread(
	app: Awaited<ReturnType<typeof setup>>,
): Promise<string> {
	await app.repo.open();
	await app.repo.selectCommit("Change main");
	// Read while the graph is still on screen: opening the review panel takes
	// the layout the commit rows live in with it.
	const commit = app.repo.shaOf("Change main");
	await app.repo.openCommitFile(FILE);

	await app.review.commentOnHunk(0);
	await app.review.write(COMMENT);
	await app.review.submit();
	await app.review.openPanel();

	const threads = await waitFor("the review panel's threads", () => {
		const showing = app.review.threads();
		return showing.length > 0 ? showing : null;
	});
	expect(threads).toEqual([ANCHOR]);
	expect(app.review.states()).toEqual(["open"]);
	await waitFor("the unresolved review badge", () =>
		app.review.reviewBadgeCount() === 1 ? true : null,
	);

	return commit;
}

function fileOf(rows: string[]): string {
	return `${rows.join("\n")}\n`;
}
