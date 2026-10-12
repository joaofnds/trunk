/** Whether a diff can take a new comment at all: every diff but a compare,
 *  whose two sides no review anchors a thread against. */
export function diffCanTakeComments(view: { compare: boolean }): boolean {
	return !view.compare;
}

/** Whether a diff takes a new comment now, before each control's own diff-kind
 *  and merge rule: always in review mode, and otherwise only while review
 *  threads show. */
export function diffTakesComments(view: {
	compare: boolean;
	reviewMode: boolean;
	threadsHidden: boolean;
}): boolean {
	if (!diffCanTakeComments(view)) return false;
	if (view.reviewMode) return true;
	return !view.threadsHidden;
}
