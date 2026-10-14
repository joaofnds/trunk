import type { ComponentProps } from "svelte";
import { vi } from "vitest";
import type ReviewPanel from "../../components/ReviewPanel.svelte";
import { ALL_THREADS } from "../../lib/review-filter.js";
import { createReviewSession } from "../../lib/review-session.svelte.js";
import type { ReviewTally } from "../../lib/types.js";

/** A diff leaf that takes a new comment and shows every thread. */
export const commentingLeaf = {
	takesComments: true,
	reviewFilter: ALL_THREADS,
};

/** A diff panel that can take a comment, takes one now, and shows every thread. */
export const commentingDiff = {
	...commentingLeaf,
	canTakeComments: true,
};

/** A count surface with no thread counted on any commit or file. */
export function noReviewCounts() {
	return {
		commentCounts: new Map<string, number>(),
		commentTallies: new Map<string, ReviewTally>(),
	};
}

/** A commit surface that shows every thread and counts none. */
export function uncountedReview() {
	return { ...noReviewCounts(), reviewFilter: ALL_THREADS };
}

type ReviewPanelProps = ComponentProps<typeof ReviewPanel>;

/** What every review panel mount passes, over the session owner the test
 *  drives. A test names only the props its behavior turns on. */
export function reviewPanelProps(
	props: Partial<ReviewPanelProps> & Pick<ReviewPanelProps, "reviewComments">,
): ReviewPanelProps {
	return {
		repoPath: "/repo",
		session: createReviewSession(),
		onJump: vi.fn(),
		onJumpToCommit: vi.fn(),
		windowFocused: false,
		keysActive: true,
		shown: true,
		...props,
	};
}
