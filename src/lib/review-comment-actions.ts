import { reportErrorToast } from "./error-report.js";
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

export function editThread(
	repoPath: string,
	commentId: string,
	text: string,
): Promise<void> {
	return safeInvoke("edit_thread", { path: repoPath, id: commentId, text });
}

export function deleteThread(
	repoPath: string,
	commentId: string,
): Promise<void> {
	return safeInvoke("delete_thread", { path: repoPath, id: commentId });
}

export function addCommitThread(
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

// Unlike the wrappers above, these four catch their own refusal instead of
// rethrowing: their callers are bare arrow functions at five call sites
// (ReviewPanel, CommitDetail, and the three diff hosts), none of which await
// or catch the promise. A published-review refusal, an agent-text edit, or an
// illegal state transition would otherwise be an unhandled rejection the user
// never sees.
async function reportRefusal(action: () => Promise<void>, fallback: string) {
	try {
		await action();
	} catch (e) {
		reportErrorToast(e, fallback);
	}
}

export function addReply(
	repoPath: string,
	threadId: string,
	text: string,
): Promise<void> {
	return reportRefusal(
		() => safeInvoke("add_reply", { path: repoPath, threadId, text }),
		"Failed to add reply",
	);
}

export function editReply(
	repoPath: string,
	replyId: string,
	text: string,
): Promise<void> {
	return reportRefusal(
		() => safeInvoke("edit_reply", { path: repoPath, id: replyId, text }),
		"Failed to edit reply",
	);
}

export function deleteReply(repoPath: string, replyId: string): Promise<void> {
	return reportRefusal(
		() => safeInvoke("delete_reply", { path: repoPath, id: replyId }),
		"Failed to delete reply",
	);
}

export function setThreadState(
	repoPath: string,
	id: string,
	next: ThreadState,
): Promise<void> {
	return reportRefusal(
		() => safeInvoke("set_thread_state", { path: repoPath, id, next }),
		"Failed to change thread state",
	);
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
