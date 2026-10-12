import type { ReviewFilter } from "./types.js";

/** Whether a diff takes a new comment, before each control's own diff-kind and
 *  merge rule: never on a compare, always in review mode, and otherwise only
 *  while review threads show. */
export function diffTakesComments(view: {
	compare: boolean;
	reviewMode: boolean;
	reviewFilter: ReviewFilter;
}): boolean {
	if (view.compare) return false;
	if (view.reviewMode) return true;
	return view.reviewFilter !== "none";
}
