import { safeInvoke } from "./invoke.js";
import type { Side, Thread } from "./types";

/**
 * Owns Review-mode center-pane state and the jump action (D-07).
 *
 * Per UI-SPEC:133 the review panel claims the CENTER pane; a jump is a
 * single-pane swap (panel -> diff -> back via the "Review" toggle), NOT a
 * relocation to the right pane. `rightPaneMode` names which of {panel, diff}
 * the center pane currently shows; `reviewActive` tracks whether the review
 * session is the active center-pane context.
 *
 * This module is a pure state+action factory: it never imports RepoView and
 * never reaches into its internals. `jumpTo` composes injected callbacks
 * (`JumpDeps`) that Plan 05 binds to RepoView's concrete selection/scroll
 * machinery, keeping the rune decoupled from the component.
 */

export type RightPaneMode = "panel" | "diff";

export interface ReviewPaneState {
	reviewActive: boolean;
	rightPaneMode: RightPaneMode;
}

// The navigation seams jumpTo composes. Plan 05 binds these to RepoView's
// commit/file selection and scroll machinery; each may be sync or async.
// `side` is threaded through so the diff scroll target picks the right
// hunk-line coordinate (Side::Old indexes the parent tree's line numbers,
// Side::New the commit's own tree). Without it, an Old-side anchor's
// line number is checked against new_start/new_lines and misses the hunk.
export interface JumpDeps {
	selectCommit(oid: string): void | Promise<void>;
	selectFile(path: string): void | Promise<void>;
	scrollToRange(startLine: number, endLine: number, side: Side): void;
}

export interface ReviewSessionManager {
	state: ReviewPaneState;
	setReviewActive(active: boolean): void;
	showPanel(): void;
	showDiff(): void;
	jumpTo(comment: Thread, deps: JumpDeps): Promise<void>;
	// Phase 72: calls `generate_review_doc` IPC and returns the markdown.
	// State is untouched; the caller composes the result (e.g. writeText for
	// clipboard). Rejection propagates verbatim.
	generate(repoPath: string, reviewId: string): Promise<string>;
}

export function createReviewSession(): ReviewSessionManager {
	const state: ReviewPaneState = $state({
		reviewActive: false,
		rightPaneMode: "panel" as RightPaneMode,
	});

	return {
		state,
		setReviewActive(active: boolean) {
			state.reviewActive = active;
			// Entering review always lands on the panel, never a stale 'diff' from a
			// prior session in the same window lifetime (260531-l02e). The Toolbar
			// Review button reflects panel-vs-diff, so a stale 'diff' would make the
			// freshly-opened panel look inactive.
			if (active) state.rightPaneMode = "panel";
		},
		async generate(repoPath: string, reviewId: string): Promise<string> {
			return await safeInvoke<string>("generate_review_doc", {
				path: repoPath,
				reviewId,
			});
		},
		showPanel() {
			state.rightPaneMode = "panel";
		},
		showDiff() {
			state.rightPaneMode = "diff";
		},
		async jumpTo(comment: Thread, deps: JumpDeps) {
			// Commit-level or orphaned comments have no line anchor and thus no
			// jump target (D-08) — stay on the panel, navigate nowhere.
			if (comment.anchor === null) return;

			const anchor = comment.anchor;
			await deps.selectCommit(anchor.commit_oid);
			// The file's Source decides diff vs full-file view downstream.
			await deps.selectFile(anchor.file_path);
			state.rightPaneMode = "diff";
			deps.scrollToRange(anchor.start_line, anchor.end_line, anchor.side);
		},
	};
}
