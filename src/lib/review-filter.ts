import type { ReviewFilter, ReviewTally, ReviewTone, Thread } from "./types.js";

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

/** The tones in the order of urgency combineReviewTone ranks them. */
export const REVIEW_TONE_ORDER: readonly ReviewTone[] = [
	"open",
	"addressed",
	"stale",
	"done",
	"dismissed",
];

/** A tally with one more thread counted in `tone`. */
export function tallyWith(
	tally: ReviewTally | undefined,
	tone: ReviewTone,
): ReviewTally {
	return { ...tally, [tone]: (tally?.[tone] ?? 0) + 1 };
}

/** Two tallies summed tone by tone. */
export function sumTallies(
	left: ReviewTally | null | undefined,
	right: ReviewTally | null | undefined,
): ReviewTally {
	const sum: ReviewTally = { ...left };
	for (const tone of REVIEW_TONE_ORDER) {
		const add = right?.[tone] ?? 0;
		if (add > 0) sum[tone] = (sum[tone] ?? 0) + add;
	}
	return sum;
}

/** A tally's tones that hold a thread, most urgent first, with their counts. */
export function tallyEntries(
	tally: ReviewTally | null | undefined,
): { tone: ReviewTone; count: number }[] {
	return REVIEW_TONE_ORDER.flatMap((tone) => {
		const count = tally?.[tone] ?? 0;
		return count > 0 ? [{ tone, count }] : [];
	});
}

/** The state a gutter draws for several threads at once: the most urgent. */
export function mostUrgentTone(threads: Thread[]): ReviewTone | null {
	let tone: ReviewTone | null = null;
	for (const thread of threads) tone = combineReviewTone(tone, thread.state);
	return tone;
}

/** The colour a state's tone draws in, for a stylesheet that reads `--thread-tone`. */
export function threadToneColor(tone: ReviewTone): string {
	return `var(--color-thread-${tone})`;
}

export function isValidReviewFilter(value: unknown): value is ReviewFilter {
	return (
		typeof value === "string" &&
		(value === "none" ||
			REVIEW_FILTER_OPTIONS.some((option) => option.value === value))
	);
}
