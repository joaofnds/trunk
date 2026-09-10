import type { ReviewFilter, ReviewTone, Thread } from "./types.js";

export const REVIEW_FILTER_OPTIONS: readonly {
	readonly value: ReviewFilter;
	readonly label: string;
}[] = [
	{ value: "all", label: "All threads" },
	{ value: "open", label: "Open" },
	{ value: "addressed", label: "Addressed" },
	{ value: "done", label: "Done" },
	{ value: "dismissed", label: "Dismissed" },
	{ value: "stale", label: "Stale" },
];

export function threadMatchesFilter(
	thread: Thread,
	filter: ReviewFilter,
): boolean {
	if (filter === "none") return false;
	if (filter === "all") return true;
	if (filter === "stale") return thread.stale;
	return thread.state === filter;
}

/** The threads that receive a count pill for a filter. The default view only
 * counts unresolved work; explicit state/stale filters count their matches. */
export function badgeToneForThread(
	thread: Thread,
	filter: ReviewFilter,
): ReviewTone | null {
	if (!threadMatchesFilter(thread, filter)) return null;
	if (filter === "all") {
		if (thread.state === "open") return "open";
		if (thread.state === "addressed") return "addressed";
		return null;
	}
	if (filter === "stale") return "stale";
	if (
		filter === "open" ||
		filter === "addressed" ||
		filter === "done" ||
		filter === "dismissed"
	) {
		return filter;
	}
	return null;
}

export function filterThreads(
	threads: Thread[],
	filter: ReviewFilter,
): Thread[] {
	return threads.filter((thread) => threadMatchesFilter(thread, filter));
}

export function countBadgeThreads(
	threads: Thread[],
	filter: ReviewFilter,
): number {
	let count = 0;
	for (const thread of threads) {
		if (badgeToneForThread(thread, filter) !== null) count++;
	}
	return count;
}

/** Combine tones for a roll-up bucket. The first tone in this order wins, so
 * an unresolved/open item keeps a bucket visually actionable. */
export function combineReviewTone(
	left: ReviewTone | null | undefined,
	right: ReviewTone | null | undefined,
): ReviewTone | null {
	if (left === "open" || right === "open") return "open";
	if (left === "addressed" || right === "addressed") return "addressed";
	if (left === "stale" || right === "stale") return "stale";
	if (left === "done" || right === "done") return "done";
	if (left === "dismissed" || right === "dismissed") return "dismissed";
	return null;
}

export function isValidReviewFilter(value: unknown): value is ReviewFilter {
	return (
		typeof value === "string" &&
		(value === "none" ||
			REVIEW_FILTER_OPTIONS.some((option) => option.value === value))
	);
}
