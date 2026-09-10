import type { PanelDiffKind } from "./comment-matching.js";
import { createDraft, type Draft } from "./draft.svelte.js";
import type { Anchor, Thread } from "./types.js";

/** The transient editors a thread owns while it is mounted on any surface. */
export interface ThreadEditorSession {
	rootEdit: Draft;
	reply: Draft;
	replyEdit: Draft;
	readonly editingReplyId: string | null;
	readonly replySaving: boolean;
	readonly replyEditSaving: boolean;
	setEditingReply(id: string | null): void;
	setReplySaving(saving: boolean): void;
	setReplyEditSaving(saving: boolean): void;
}

/** A mounted review surface whose same thread needs an independent editor. */
export type ReviewEditorHost = "review-panel" | "commit-notes" | "diff";

/** The target and draft owned by a review panel's add-note composer. */
export interface ReviewNoteEditorSession {
	readonly draft: Draft;
	readonly target: string | null;
	readonly saving: boolean;
	open(target: string): void;
	close(): void;
	setSaving(saving: boolean): void;
}

export type ReviewComposerMode = "diff" | "full-file";
export type ReviewComposerSurface = "diff";
export type ReviewComposerContext = "normal" | "rebase";

/** The navigation identity that owns one diff composer session. */
export interface ReviewComposerTarget {
	readonly context: ReviewComposerContext;
	readonly kind: PanelDiffKind;
	readonly commitOid: string | null;
	readonly compareBaseOid: string | null;
	readonly filePath: string | null;
}

export function reviewComposerTargetsEqual(
	left: ReviewComposerTarget | null,
	right: ReviewComposerTarget | null,
): boolean {
	return (
		left?.context === right?.context &&
		left?.kind === right?.kind &&
		left?.commitOid === right?.commitOid &&
		left?.compareBaseOid === right?.compareBaseOid &&
		left?.filePath === right?.filePath
	);
}

export interface ReviewComposerCapture {
	readonly anchor: Anchor;
	readonly cachedExcerpt: string;
}

/** A diff composer that survives conditional DiffPanel mounts. */
export interface ReviewComposerSession {
	readonly draft: Draft;
	readonly mode: ReviewComposerMode | null;
	readonly filePath: string | null;
	readonly captured: ReviewComposerCapture | null;
	readonly originatingReviewId: string | null;
	readonly target: ReviewComposerTarget | null;
	openDiff(
		captured: ReviewComposerCapture,
		reviewId: string | null,
		target: ReviewComposerTarget,
	): boolean;
	openFullFile(
		filePath: string,
		captured: ReviewComposerCapture,
		reviewId: string | null,
		target: ReviewComposerTarget,
	): boolean;
	close(): void;
}

/** A successful or failed snapshot of one active review's thread read. */
export interface ReviewThreadSnapshot {
	readonly reviewId: string | null;
	readonly threads: readonly Thread[];
	readonly authoritative: boolean;
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
	composer(
		surface: ReviewComposerSurface,
		target?: ReviewComposerTarget,
	): ReviewComposerSession;
	/** Reconciles one authoritative review snapshot and stale replies. */
	reconcile(snapshot: ReviewThreadSnapshot): void;
}

export function createThreadEditorSession(): ThreadEditorSession {
	const state = $state({
		editingReplyId: null as string | null,
		replySaving: false,
		replyEditSaving: false,
	});

	return {
		rootEdit: createDraft(),
		reply: createDraft(),
		replyEdit: createDraft(),
		get editingReplyId() {
			return state.editingReplyId;
		},
		get replySaving() {
			return state.replySaving;
		},
		get replyEditSaving() {
			return state.replyEditSaving;
		},
		setEditingReply(id: string | null) {
			state.editingReplyId = id;
		},
		setReplySaving(saving: boolean) {
			state.replySaving = saving;
		},
		setReplyEditSaving(saving: boolean) {
			state.replyEditSaving = saving;
		},
	};
}

export function createReviewNoteEditorSession(
	getDraft: (target: string) => Draft,
): ReviewNoteEditorSession {
	const state = $state({ target: null as string | null, saving: false });
	const idleDraft = createDraft();

	return {
		get draft() {
			return state.target === null ? idleDraft : getDraft(state.target);
		},
		get target() {
			return state.target;
		},
		get saving() {
			return state.saving;
		},
		open(target: string) {
			const draft = getDraft(target);
			state.target = target;
			if (!draft.editing) draft.open();
		},
		close() {
			if (state.target !== null) getDraft(state.target).close();
			state.target = null;
			state.saving = false;
			idleDraft.close();
		},
		setSaving(saving: boolean) {
			state.saving = saving;
		},
	};
}

export function createReviewComposerSession(
	onClose?: () => void,
): ReviewComposerSession {
	const state = $state({
		mode: null as ReviewComposerMode | null,
		filePath: null as string | null,
		captured: null as ReviewComposerCapture | null,
		originatingReviewId: null as string | null,
		target: null as ReviewComposerTarget | null,
	});
	const draft = createDraft();

	function open(
		mode: ReviewComposerMode,
		filePath: string | null,
		captured: ReviewComposerCapture,
		reviewId: string | null,
		target: ReviewComposerTarget,
	): boolean {
		if (
			state.target !== null &&
			!reviewComposerTargetsEqual(state.target, target) &&
			draft.editing
		) {
			return false;
		}

		if (
			state.target !== null &&
			!reviewComposerTargetsEqual(state.target, target)
		) {
			draft.close();
		}

		state.mode = mode;
		state.filePath = filePath;
		state.captured = captured;
		state.originatingReviewId = reviewId;
		state.target = target;

		if (!draft.editing) draft.open();
		return true;
	}

	return {
		draft,
		get mode() {
			return state.mode;
		},
		get filePath() {
			return state.filePath;
		},
		get captured() {
			return state.captured;
		},
		get originatingReviewId() {
			return state.originatingReviewId;
		},
		get target() {
			return state.target;
		},
		openDiff(captured, reviewId, target) {
			return open("diff", null, captured, reviewId, target);
		},
		openFullFile(filePath, captured, reviewId, target) {
			return open("full-file", filePath, captured, reviewId, target);
		},
		close() {
			draft.close();
			state.mode = null;
			state.filePath = null;
			state.captured = null;
			state.originatingReviewId = null;
			state.target = null;
			onClose?.();
		},
	};
}

export function createReviewEditorStore(): ReviewEditorStore {
	interface ThreadSessionEntry {
		reviewId: string | null;
		threadId: string;
		session: ThreadEditorSession;
	}

	const threadSessions = new Map<string, ThreadSessionEntry>();
	const drafts = new Map<string, Draft>();
	const noteSessions = new Map<string, ReviewNoteEditorSession>();
	const composerSessions = new Map<string, ReviewComposerSession>();
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
	const threadIdentity = (reviewId: string | null, threadId: string) =>
		JSON.stringify([reviewId, threadId]);

	function closeThreadSession(session: ThreadEditorSession): void {
		session.rootEdit.close();
		session.reply.close();
		session.replyEdit.close();
		session.setEditingReply(null);
		session.setReplySaving(false);
		session.setReplyEditSaving(false);
	}

	return {
		thread(reviewId, host, threadId) {
			const key = JSON.stringify([reviewId, host, threadId]);
			let entry = threadSessions.get(key);
			if (!entry) {
				entry = {
					reviewId,
					threadId,
					session: createThreadEditorSession(),
				};
				threadSessions.set(key, entry);
			}
			return entry.session;
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
		composer(surface, target) {
			const key = JSON.stringify([surface, target ?? null]);
			let session = composerSessions.get(key);
			if (!session) {
				let created: ReviewComposerSession | null = null;
				created = createReviewComposerSession(() => {
					if (composerSessions.get(key) === created) {
						composerSessions.delete(key);
					}
				});
				session = created;
				composerSessions.set(key, created);
			}
			return session;
		},
		reconcile({ reviewId, threads, authoritative }) {
			if (!authoritative) return;

			const liveThreads = new Map(
				threads.map((thread) => [
					threadIdentity(thread.review_id, thread.id),
					thread,
				]),
			);

			for (const [key, entry] of threadSessions) {
				if (entry.reviewId !== reviewId) continue;

				const thread = liveThreads.get(
					threadIdentity(entry.reviewId, entry.threadId),
				);
				if (!thread) {
					closeThreadSession(entry.session);
					threadSessions.delete(key);
					continue;
				}

				const editingReplyId = entry.session.editingReplyId;
				if (
					editingReplyId !== null &&
					!thread.replies.some((reply) => reply.id === editingReplyId)
				) {
					entry.session.replyEdit.close();
					entry.session.setEditingReply(null);
				}
			}
		},
	};
}
