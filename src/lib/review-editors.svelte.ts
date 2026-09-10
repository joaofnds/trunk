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

/** The target and draft owned by a review panel's add-note composer. */
export interface ReviewNoteEditorSession {
	readonly draft: Draft;
	readonly target: string | null;
	open(target: string): void;
	close(): void;
}

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
	note(reviewId: string | null, surface: string): ReviewNoteEditorSession;
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

export function createReviewNoteEditorSession(
	getDraft: (target: string) => Draft,
): ReviewNoteEditorSession {
	const state = $state({ target: null as string | null });
	const idleDraft = createDraft();

	return {
		get draft() {
			return state.target === null ? idleDraft : getDraft(state.target);
		},
		get target() {
			return state.target;
		},
		open(target: string) {
			const draft = getDraft(target);
			state.target = target;
			if (!draft.editing) draft.open();
		},
		close() {
			if (state.target !== null) getDraft(state.target).close();
			state.target = null;
			idleDraft.close();
		},
	};
}

export function createReviewEditorStore(): ReviewEditorStore {
	const threadSessions = new Map<string, ThreadEditorSession>();
	const drafts = new Map<string, Draft>();
	const noteSessions = new Map<string, ReviewNoteEditorSession>();
	const getDraft = (
		reviewId: string | null,
		surface: string,
		target: string,
	) => {
		const key = JSON.stringify([reviewId, surface, target]);
		let draft = drafts.get(key);
		if (!draft) {
			draft = createDraft();
			drafts.set(key, draft);
		}
		return draft;
	};

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
		draft: getDraft,
		note(reviewId, surface) {
			const key = JSON.stringify([reviewId, surface]);
			let session = noteSessions.get(key);
			if (!session) {
				session = createReviewNoteEditorSession((target) =>
					getDraft(reviewId, surface, target),
				);
				noteSessions.set(key, session);
			}
			return session;
		},
	};
}
