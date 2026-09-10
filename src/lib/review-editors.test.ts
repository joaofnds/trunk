import { describe, expect, it } from "vitest";
import { aReply, aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	createReviewEditorStore,
	type ReviewComposerTarget,
} from "./review-editors.svelte.js";
import type { Anchor } from "./types.js";

describe("review editor store", () => {
	const diffTarget = {
		context: "normal",
		kind: "commit",
		commitOid: "commit-1",
		compareBaseOid: null,
		filePath: "src/main.ts",
	} satisfies ReviewComposerTarget;

	it("keeps thread editor state stable across remounts and filters", () => {
		const store = createReviewEditorStore();
		const first = store.thread("review-a", "review-panel", "thread-1");

		first.rootEdit.open("unfinished root edit");
		first.reply.open("unfinished reply");
		first.replyEdit.open("unfinished reply edit");
		first.setEditingReply("reply-1");

		const remounted = store.thread("review-a", "review-panel", "thread-1");
		expect(remounted).toBe(first);
		expect(remounted.rootEdit.text).toBe("unfinished root edit");
		expect(remounted.reply.text).toBe("unfinished reply");
		expect(remounted.replyEdit.text).toBe("unfinished reply edit");
		expect(remounted.editingReplyId).toBe("reply-1");

		expect(store.thread("review-b", "review-panel", "thread-1")).not.toBe(
			first,
		);
	});

	it("keeps the same thread independent between review hosts", () => {
		const store = createReviewEditorStore();
		const panel = store.thread("review-a", "review-panel", "thread-1");
		const commitNotes = store.thread("review-a", "commit-notes", "thread-1");

		panel.rootEdit.open("panel-only edit");

		expect(commitNotes).not.toBe(panel);
		expect(commitNotes.rootEdit.editing).toBe(false);
	});

	it("scopes add-note drafts by review, surface, and target", () => {
		const store = createReviewEditorStore();
		const first = store.draft("review-a", "commit-note", "commit-1");
		first.open("unfinished note");

		expect(store.draft("review-a", "commit-note", "commit-1")).toBe(first);
		expect(store.draft("review-a", "commit-note", "commit-2")).not.toBe(first);
		expect(store.draft("review-b", "commit-note", "commit-1")).not.toBe(first);
		expect(store.draft("review-a", "review-note", "commit-1")).not.toBe(first);
	});

	it("keeps an add-note target and text across panel remounts", () => {
		const store = createReviewEditorStore();
		const first = store.note("review-a", "review-note");

		first.open("commit-1");
		first.draft.text = "unfinished note";

		const remounted = store.note("review-a", "review-note");
		expect(remounted).toBe(first);
		expect(remounted.target).toBe("commit-1");
		expect(remounted.draft.text).toBe("unfinished note");
		expect(remounted.draft.editing).toBe(true);
	});

	it("drops sessions for threads removed from the raw review data", () => {
		const store = createReviewEditorStore();
		const session = store.thread("review-a", "review-panel", "thread-1");
		session.rootEdit.open("unfinished root edit");
		session.reply.open("unfinished reply");
		session.replyEdit.open("unfinished reply edit");
		session.setEditingReply("reply-1");

		store.reconcile({
			reviewId: "review-a",
			threads: [],
			authoritative: true,
		});

		const remounted = store.thread("review-a", "review-panel", "thread-1");
		expect(remounted).not.toBe(session);
		expect(remounted.rootEdit.editing).toBe(false);
		expect(remounted.reply.editing).toBe(false);
		expect(remounted.replyEdit.editing).toBe(false);
		expect(remounted.editingReplyId).toBeNull();
	});

	it("clears a reply editor when the raw thread no longer has that reply", () => {
		const store = createReviewEditorStore();
		const session = store.thread("review-a", "diff", "thread-1");
		session.replyEdit.open("unfinished reply edit");
		session.setEditingReply("reply-1");
		const thread = aThread({
			id: "thread-1",
			review_id: "review-a",
			replies: [aReply({ id: "reply-1" })],
		});

		store.reconcile({
			reviewId: "review-a",
			threads: [thread],
			authoritative: true,
		});
		expect(session.editingReplyId).toBe("reply-1");

		store.reconcile({
			reviewId: "review-a",
			threads: [{ ...thread, replies: [] }],
			authoritative: true,
		});
		expect(session.editingReplyId).toBeNull();
		expect(session.replyEdit.editing).toBe(false);
	});

	it("preserves sessions from inactive reviews and failed reads", () => {
		const store = createReviewEditorStore();
		const session = store.thread("review-a", "review-panel", "thread-1");
		session.rootEdit.open("unfinished root edit");

		store.reconcile({
			reviewId: "review-b",
			threads: [],
			authoritative: true,
		});
		store.reconcile({
			reviewId: "review-a",
			threads: [],
			authoritative: false,
		});

		expect(store.thread("review-a", "review-panel", "thread-1")).toBe(session);
		expect(session.rootEdit.text).toBe("unfinished root edit");
	});

	it("keeps a diff composer capture and draft across panel remounts", () => {
		const store = createReviewEditorStore();
		const capture = {
			anchor: {
				commit_oid: "commit-1",
				file_path: "src/main.ts",
				source: "FullFile",
				side: "New",
				start_line: 1,
				end_line: 1,
			} satisfies Anchor,
			cachedExcerpt: "+ kept line",
		};
		const first = store.composer("diff");

		first.openFullFile("src/main.ts", capture, "review-a", diffTarget);
		first.draft.text = "unfinished diff comment";

		const remounted = store.composer("diff");
		expect(remounted).toBe(first);
		expect(remounted.mode).toBe("full-file");
		expect(remounted.filePath).toBe("src/main.ts");
		expect(remounted.captured).toEqual(capture);
		expect(remounted.originatingReviewId).toBe("review-a");
		expect(remounted.draft.text).toBe("unfinished diff comment");
	});

	it("does not retarget a dirty diff composer", () => {
		const store = createReviewEditorStore();
		const session = store.composer("diff");
		const capture = {
			anchor: {
				commit_oid: "commit-1",
				file_path: "src/main.ts",
				source: "Diff",
				side: "New",
				start_line: 1,
				end_line: 1,
			} satisfies Anchor,
			cachedExcerpt: "+ original line",
		};

		session.openDiff(capture, "review-a", diffTarget);
		session.draft.text = "unfinished comment";

		const opened = session.openDiff(
			{
				...capture,
				anchor: { ...capture.anchor, commit_oid: "commit-2" },
			},
			"review-a",
			{ ...diffTarget, commitOid: "commit-2" },
		);

		expect(opened).toBe(false);
		expect(session.captured).toEqual(capture);
		expect(session.draft.text).toBe("unfinished comment");
	});

	it("scopes diff composers by navigation target", () => {
		const store = createReviewEditorStore();
		const first = store.composer("diff", diffTarget);
		const second = store.composer("diff", {
			...diffTarget,
			commitOid: "commit-2",
		});

		expect(second).not.toBe(first);
		expect(store.composer("diff", diffTarget)).toBe(first);
	});
});
