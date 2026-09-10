import { describe, expect, it } from "vitest";
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
});
