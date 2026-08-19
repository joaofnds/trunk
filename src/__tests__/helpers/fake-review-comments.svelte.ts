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
	lastError: string | null;
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
		lastError: null,
	};
}

export function createFakeReviewComments(): FakeReviewComments {
	let seeded = emptyStore();
	let refreshCount = 0;

	const state = $state({ ...emptyStore(), revision: 0 });

	const hasThreads = $derived(state.threads.length > 0);

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
			state.lastError = seeded.lastError;
			state.revision += 1;
			return Promise.resolve();
		},
		destroy() {},
		seed(next: Partial<Store>) {
			seeded = { ...seeded, ...next };
		},
		reset() {
			seeded = emptyStore();
			Object.assign(state, emptyStore(), { revision: 0 });
			refreshCount = 0;
		},
	};
}
