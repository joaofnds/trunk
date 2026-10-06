import { buildCommentCounts } from "../../lib/comment-counts.js";
import type { ReviewCommentsManager } from "../../lib/review-comments.svelte.js";
import type {
	Review,
	ReviewSnapshots,
	SessionCommit,
	Thread,
} from "../../lib/types.js";

interface Store {
	threads: Thread[];
	reviews: Review[];
	activeReviewId: string | null;
	snapshots: ReviewSnapshots;
	commits: SessionCommit[];
	threadsAuthoritative: boolean;
	lastError: string | null;
	/** What a read naming a review other than the active one returns. */
	otherReviews: Record<string, { threads: Thread[]; commits: SessionCommit[] }>;
}

export interface FakeReviewComments extends ReviewCommentsManager {
	/**
	 * Stage the next store contents. Nothing a consumer can observe changes
	 * until refresh() runs — the real rune only publishes what a round trip
	 * returned, so a Fake that published on seed would hide every
	 * missing-refresh bug.
	 */
	seed(next: Partial<Store>): void;
	reset(): void;
	readonly refreshCount: number;
}

function emptyStore(): Store {
	return {
		threads: [],
		reviews: [],
		activeReviewId: null,
		snapshots: { working_tree_snapshot: null, index_snapshot: null },
		commits: [],
		threadsAuthoritative: true,
		lastError: null,
		otherReviews: {},
	};
}

export function createFakeReviewComments(): FakeReviewComments {
	let seeded = emptyStore();
	let refreshCount = 0;

	const state = $state({
		...emptyStore(),
		revision: 0,
		selectedReviewId: null as string | null,
	});

	const hasThreads = $derived(state.threads.length > 0);
	const activeReview = $derived(
		state.reviews.find((review) => review.id === state.activeReviewId) ?? null,
	);

	const shownReviewId = $derived(
		state.reviews.some((review) => review.id === state.selectedReviewId)
			? state.selectedReviewId
			: state.activeReviewId,
	);
	const shownReview = $derived(
		state.reviews.find((review) => review.id === shownReviewId) ?? null,
	);
	const shown = $derived(
		shownReviewId === state.activeReviewId
			? { threads: state.threads, commits: state.commits }
			: (state.otherReviews[shownReviewId ?? ""] ?? {
					threads: [],
					commits: [],
				}),
	);

	const oids = $derived(
		new Set(state.commits.map((c) => c.oid)) as ReadonlySet<string>,
	);

	const counts = $derived(buildCommentCounts(state.threads, state.snapshots));

	return {
		get threads() {
			return state.threads;
		},
		get reviews() {
			return state.reviews;
		},
		get activeReviewId() {
			return state.activeReviewId;
		},
		get activeReview() {
			return activeReview;
		},
		get shownReviewId() {
			return shownReviewId;
		},
		get shownReview() {
			return shownReview;
		},
		get shownThreads() {
			return shown.threads;
		},
		get shownCommits() {
			return shown.commits;
		},
		get snapshots() {
			return state.snapshots;
		},
		get hasThreads() {
			return hasThreads;
		},
		get commits() {
			return state.commits;
		},
		get oids() {
			return oids;
		},
		get revision() {
			return state.revision;
		},
		get threadsAuthoritative() {
			return state.threadsAuthoritative;
		},
		get lastError() {
			return state.lastError;
		},
		get totalCount() {
			return state.threads.length;
		},
		get countByCommit() {
			return counts.byCommit;
		},
		get countByFile() {
			return counts.byFile;
		},
		get refreshCount() {
			return refreshCount;
		},
		refresh() {
			refreshCount += 1;
			state.threads = seeded.threads;
			state.reviews = seeded.reviews;
			state.activeReviewId = seeded.activeReviewId;
			state.snapshots = seeded.snapshots;
			state.commits = seeded.commits;
			state.threadsAuthoritative = seeded.threadsAuthoritative;
			state.lastError = seeded.lastError;
			state.otherReviews = seeded.otherReviews;
			state.revision += 1;
			return Promise.resolve();
		},
		select(reviewId: string) {
			state.selectedReviewId = reviewId;
			return this.refresh();
		},
		destroy() {},
		seed(next: Partial<Store>) {
			seeded = { ...seeded, ...next };
		},
		reset() {
			seeded = emptyStore();
			Object.assign(state, emptyStore(), {
				revision: 0,
				selectedReviewId: null,
			});
			refreshCount = 0;
		},
	};
}
