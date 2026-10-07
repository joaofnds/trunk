import { errorMessage } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
import type { ReviewCommentsManager } from "./review-comments.svelte.js";
import { showToast } from "./toast.svelte.js";

// What the reviews list and the shown review's header both do to a review. A
// failure lands in a toast, since neither surface has a place to show one.

export async function activateReview(
	repoPath: string,
	reviewId: string,
): Promise<void> {
	try {
		await safeInvoke("set_active_review", { path: repoPath, reviewId });
	} catch (e) {
		showToast(errorMessage(e, "Failed to switch review"), "error");
	}
}

export async function startNewReview(
	repoPath: string,
	reviewComments: ReviewCommentsManager,
): Promise<void> {
	try {
		const id = await safeInvoke<string>("create_review", {
			path: repoPath,
			title: null,
		});
		await reviewComments.select(id);
	} catch (e) {
		showToast(errorMessage(e, "Failed to create review"), "error");
	}
}

export async function renameReview(
	repoPath: string,
	reviewId: string,
	title: string,
): Promise<void> {
	try {
		await safeInvoke("rename_review", { path: repoPath, reviewId, title });
	} catch (e) {
		showToast(errorMessage(e, "Failed to rename review"), "error");
	}
}
