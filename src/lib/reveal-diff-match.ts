function revealOffset(
	start: number,
	end: number,
	visibleStart: number,
	visibleEnd: number,
): number {
	if (start < visibleStart || end - start > visibleEnd - visibleStart)
		return start - visibleStart;

	return Math.max(0, end - visibleEnd);
}

/** The row is mounted. Reveal the occurrence inside it, which can be many
 * wrapped lines below the row's top or far across an unwrapped split half. */
export function revealDiffMatch(mark: HTMLElement): void {
	const viewport = mark.closest<HTMLElement>(".exact-virtual-viewport");
	if (!viewport) return;

	const clip = viewport.getBoundingClientRect();
	const match = mark.getBoundingClientRect();
	const dy = revealOffset(match.top, match.bottom, clip.top, clip.bottom);
	if (dy) viewport.scrollTop += dy;

	const pan = mark.closest(".split-pan");
	const window = pan?.parentElement?.getBoundingClientRect();
	const bounds = window ?? clip;
	const dx = revealOffset(match.left, match.right, bounds.left, bounds.right);
	if (!dx) return;

	// A short half stops moving at its own end while the other half keeps
	// panning. Its rendered offset is the origin for the return trip.
	const panLeft =
		pan && window
			? window.left - pan.getBoundingClientRect().left
			: viewport.scrollLeft;
	viewport.scrollLeft = panLeft + dx;
}
