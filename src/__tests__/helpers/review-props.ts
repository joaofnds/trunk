import { ALL_THREADS } from "../../lib/review-filter.js";
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
