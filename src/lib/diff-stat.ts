// Log-scaled fractions of the Diff-column bar track for a commit's insertions
// and deletions. A fixed CAP keeps a given commit's bar width stable regardless
// of what else is on screen — magnitude is conveyed by the bar's length, exact
// counts by the hover tooltip.
//
//   total = insertions + deletions
//   scale = min(1, log1p(total) / log1p(cap))   // 0..1 of the full track
//   addFrac = scale * insertions / total
//   delFrac = scale * deletions / total
//
// The min-sliver guarantee (a nonzero side always renders visibly) lives in the
// component as CSS min-width, not here — these are pure ratios.
export function diffBarFractions(
	insertions: number,
	deletions: number,
	cap = 1000,
): { addFrac: number; delFrac: number } {
	const total = insertions + deletions;
	if (total === 0) return { addFrac: 0, delFrac: 0 };

	const scale = Math.min(1, Math.log1p(total) / Math.log1p(cap));
	return {
		addFrac: (scale * insertions) / total,
		delFrac: (scale * deletions) / total,
	};
}
