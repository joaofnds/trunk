import { describe, expect, it } from "vitest";
import { aReply, aThread } from "../__tests__/helpers/thread-fixture.js";
import { createReviewEditorStore } from "./review-editors.svelte.js";

describe("review editor store", () => {
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

		store.reconcile([]);

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

		store.reconcile([thread]);
		expect(session.editingReplyId).toBe("reply-1");

		store.reconcile([{ ...thread, replies: [] }]);
		expect(session.editingReplyId).toBeNull();
		expect(session.replyEdit.editing).toBe(false);
	});
});
