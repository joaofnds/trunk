import { safeInvoke } from "./invoke.js";
import type { Anchor, Draft, ThreadState } from "./types.js";

// Thin wrappers over the review IPC commands so every inline host (diff views,
// commit-detail) shares one source of the exact command names + arg shapes:
//   edit_thread        { path, id, text }
//   delete_thread      { path, id }
//   add_commit_thread  { path, commitOid, text }
//   add_reply          { path, threadId, text }
//   edit_reply         { path, id, text }
//   delete_reply       { path, id }
//   set_thread_state   { path, id, next }
// All seven emit `reviews-changed`, so callers do NOT refetch manually — the
// rune's listener round-trips the update. `add_commit_thread` creates the active
// review when the repo has none, so no caller has to establish one first.

export function editComment(
	repoPath: string,
	commentId: string,
	text: string,
): Promise<void> {
	return safeInvoke("edit_thread", { path: repoPath, id: commentId, text });
}

export function deleteComment(
	repoPath: string,
	commentId: string,
): Promise<void> {
	return safeInvoke("delete_thread", { path: repoPath, id: commentId });
}

export function addCommitComment(
	repoPath: string,
	commitOid: string,
	text: string,
): Promise<void> {
	return safeInvoke("add_commit_thread", {
		path: repoPath,
		commitOid,
		text,
	});
}

export function addReply(
	repoPath: string,
	threadId: string,
	text: string,
): Promise<void> {
	return safeInvoke("add_reply", { path: repoPath, threadId, text });
}

export function editReply(
	repoPath: string,
	replyId: string,
	text: string,
): Promise<void> {
	return safeInvoke("edit_reply", { path: repoPath, id: replyId, text });
}

export function deleteReply(repoPath: string, replyId: string): Promise<void> {
	return safeInvoke("delete_reply", { path: repoPath, id: replyId });
}

export function setThreadState(
	repoPath: string,
	id: string,
	next: ThreadState,
): Promise<void> {
	return safeInvoke("set_thread_state", { path: repoPath, id, next });
}

/// The draft the composer autosaves into. It has no review foreign key, so it
/// survives a crash without stranding a review — and a cancelled composer has
/// to clear it, or the next open reopens with text the user abandoned.
export function saveDraft(
	repoPath: string,
	text: string,
	anchor: Anchor | null,
): Promise<void> {
	return safeInvoke("save_draft", { path: repoPath, text, anchor });
}

export function getDraft(repoPath: string): Promise<Draft | null> {
	return safeInvoke("get_draft", { path: repoPath });
}

export function deleteDraft(repoPath: string): Promise<void> {
	return safeInvoke("delete_draft", { path: repoPath });
}
