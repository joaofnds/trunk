import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

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

	it("becomes a thread the panel keeps through publishing", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);

		await app.review.publish();

		const published = await waitFor(
			"the actions a published thread offers",
			() => {
				const offered = app.review.actions();
				return offered.length > 0 && !offered.includes("Delete")
					? offered
					: null;
			},
		);
		expect(published).toEqual(["Mark done", "Dismiss", "Edit"]);
		expect(app.review.threads()).toEqual([ANCHOR]);
		expect(app.review.states()).toEqual(["open"]);
	});

	it("filters a completed thread and copies its review document", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		const commit = await createReviewThread(app);

		await app.review.publish();

		await app.review.markDone();

		await waitFor("the thread to reach done", () =>
			app.review.states()[0] === "done" ? true : null,
		);
		expect(app.review.states()).toEqual(["done"]);
		await waitFor("the unresolved review badge to disappear", () =>
			app.review.reviewBadgeCount() === null ? true : null,
		);

		await app.review.showReviewFilter(
			"done",
			() => app.review.reviewBadgeCount() === 1,
		);

		await app.review.copyDoc();

		const doc = await waitFor(
			"the copied review doc",
			() => app.clipboard.text,
		);
		expect(doc).toContain(`${ANCHOR} (${commit}, after) — done`);
	});

	it.each(["none", "done"] as const)(
		"copies the raw review when the %s filter hides every thread",
		async (filter) => {
			const app = await setup({ repo: TWO_COMMITS });
			const commit = await createReviewThread(app);
			await app.review.showReviewFilter(
				filter,
				() => app.review.threads().length === 0,
			);

			await app.review.copyDoc();

			const doc = await waitFor(
				"the copied review doc",
				() => app.clipboard.text,
			);
			expect(app.review.threads()).toEqual([]);
			expect(doc).toContain(`${ANCHOR} (${commit}, after) — open`);
			expect(doc).toContain(COMMENT);
		},
	);

	it.each(["none", "done"] as const)(
		"ends the raw review when the %s filter hides every thread",
		async (filter) => {
			const app = await setup({ repo: TWO_COMMITS });
			await createReviewThread(app);
			await app.review.showReviewFilter(
				filter,
				() => app.review.threads().length === 0,
			);

			await app.review.publish();
			await app.review.showReviewFilter("all", () => {
				const actions = app.review.actions();
				return actions.length > 0 && !actions.includes("Delete");
			});

			expect(app.review.threads()).toEqual([ANCHOR]);
			expect(app.review.states()).toEqual(["open"]);
			expect(app.review.actions()).toEqual(["Mark done", "Dismiss", "Edit"]);
		},
	);

	it("retains an unsaved diff comment and its range through hiding and leaving the diff", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		const commit = await createReviewThread(app);
		await app.review.jumpToThread();
		await app.review.commentOnHunk(0);
		await app.review.write("keep this unsaved comment");

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

		const restored = await waitFor("the retained diff comment", () =>
			app.review.composerDraft(),
		);
		expect(restored).toEqual({
			text: "keep this unsaved comment",
			range: "Comments on lines 3-3",
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

	it("keeps panel and inline reply drafts separate through hiding and remounting", async () => {
		const app = await setup({ repo: TWO_COMMITS });
		await createReviewThread(app);
		await app.review.writeReply("panel reply in progress");
		await app.review.jumpToThread();
		await app.review.writeReply("inline reply in progress");

		await app.review.showReviewFilter(
			"none",
			() => app.review.threads().length === 0,
		);
		await app.review.openPanel();
		await app.review.showReviewFilter(
			"all",
			() => app.review.threads().length === 1,
		);
		const panelReply = await waitFor("the panel reply", () =>
			app.review.replyDraft(),
		);
		await app.review.jumpToThread();
		const inlineReply = await waitFor("the inline reply", () =>
			app.review.replyDraft(),
		);

		expect(panelReply).toBe("panel reply in progress");
		expect(inlineReply).toBe("inline reply in progress");
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
