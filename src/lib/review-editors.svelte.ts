import { createDraft, type Draft } from "./draft.svelte.js";

/** The transient editors a thread owns while it is mounted on any surface. */
export interface ThreadEditorSession {
	rootEdit: Draft;
	reply: Draft;
	replyEdit: Draft;
	readonly editingReplyId: string | null;
	setEditingReply(id: string | null): void;
}

/** A mounted review surface whose same thread needs an independent editor. */
export type ReviewEditorHost = "review-panel" | "commit-notes" | "diff";

/**
 * Repository-tab lifetime for review editors. The key includes the active
 * review so a draft from one review cannot be submitted into another one after
 * switching the active review.
 */
export interface ReviewEditorStore {
	thread(
		reviewId: string | null,
		host: ReviewEditorHost,
		threadId: string,
	): ThreadEditorSession;
	draft(reviewId: string | null, surface: string, target: string): Draft;
}

export function createThreadEditorSession(): ThreadEditorSession {
	const state = $state({ editingReplyId: null as string | null });

	return {
		rootEdit: createDraft(),
		reply: createDraft(),
		replyEdit: createDraft(),
		get editingReplyId() {
			return state.editingReplyId;
		},
		setEditingReply(id: string | null) {
			state.editingReplyId = id;
		},
	};
}

export function createReviewEditorStore(): ReviewEditorStore {
	const threadSessions = new Map<string, ThreadEditorSession>();
	const drafts = new Map<string, Draft>();

	return {
		thread(reviewId, host, threadId) {
			const key = JSON.stringify([reviewId, host, threadId]);
			let session = threadSessions.get(key);
			if (!session) {
				session = createThreadEditorSession();
				threadSessions.set(key, session);
			}
			return session;
		},
		draft(reviewId, surface, target) {
			const key = `${reviewId ?? "none"}:${surface}:${target}`;
			let draft = drafts.get(key);
			if (!draft) {
				draft = createDraft();
				drafts.set(key, draft);
			}
			return draft;
		},
	};
}
