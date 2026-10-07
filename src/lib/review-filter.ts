import type {
	ReviewFilter,
	ReviewTally,
	ReviewTone,
	Thread,
	ThreadFilter,
	ThreadState,
} from "./types.js";

export const THREAD_STATES: readonly ThreadState[] = [
	"open",
	"addressed",
	"done",
	"dismissed",
];

export const ALL_THREADS: ThreadFilter = { states: THREAD_STATES, stale: true };

export type ThreadPreset = "all" | "needs" | "settled";

/** The review panel's one-press filters, each showing its states and the
 * stale threads among them. */
export const THREAD_PRESETS: readonly {
	id: ThreadPreset;
	label: string;
	filter: ThreadFilter;
}[] = [
	{ id: "all", label: "All", filter: ALL_THREADS },
	{
		id: "needs",
		label: "Needs me",
		filter: { states: ["open", "addressed"], stale: true },
	},
	{
		id: "settled",
		label: "Settled",
		filter: { states: ["done", "dismissed"], stale: true },
	},
];

/** The preset a filter shows exactly the threads of, if any. */
export function presetOf(filter: ReviewFilter): ThreadPreset | null {
	if (filter === "none" || !filter.stale) return null;
	const found = THREAD_PRESETS.find((preset) =>
		THREAD_STATES.every(
			(state) =>
				preset.filter.states.includes(state) === filter.states.includes(state),
		),
	);
	return found?.id ?? null;
}

/** The filter with `state` flipped, in the tally's order. Pressed while every
 * thread is hidden, it shows that state alone. */
export function toggleState(
	filter: ReviewFilter,
	state: ThreadState,
): ThreadFilter {
	if (filter === "none") return { states: [state], stale: true };

	const shown = filter.states.includes(state);
	return {
		states: THREAD_STATES.filter((candidate) =>
			candidate === state ? !shown : filter.states.includes(candidate),
		),
		stale: filter.stale,
	};
}

/** The filter with stale threads flipped. Pressed while every thread is
 * hidden, it turns stale threads on and no state. */
export function toggleStale(filter: ReviewFilter): ThreadFilter {
	if (filter === "none") return { states: [], stale: true };
	return { states: filter.states, stale: !filter.stale };
}

export function threadMatchesFilter(
	thread: Thread,
	filter: ReviewFilter,
): boolean {
	if (filter === "none") return false;
	return (
		filter.states.includes(thread.state) && (filter.stale || !thread.stale)
	);
}

/** The threads that receive a count pill for a filter. While every thread
 * shows, only unresolved work counts; a narrower filter counts what it shows. */
export function badgeToneForThread(
	thread: Thread,
	filter: ReviewFilter,
): ReviewTone | null {
	if (!threadMatchesFilter(thread, filter)) return null;
	if (presetOf(filter) !== "all") return thread.state;
	if (thread.state === "open" || thread.state === "addressed")
		return thread.state;
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

/** The threads that receive a count pill for a filter, counted by tone. */
export function tallyBadgeThreads(
	threads: Thread[],
	filter: ReviewFilter,
): ReviewTally {
	let tally: ReviewTally = {};
	for (const thread of threads) {
		const tone = badgeToneForThread(thread, filter);
		if (tone !== null) tally = tallyWith(tally, tone);
	}
	return tally;
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
