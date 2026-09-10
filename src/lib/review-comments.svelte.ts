import { listen } from "@tauri-apps/api/event";
import { createCoalescedTask } from "./coalesced-task.js";
import { buildCommentCounts } from "./comment-counts.js";
import { errorMessage } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
import { subscribeToRepoChanges } from "./repo-change-subscription.js";
import { realScheduler, type Scheduler } from "./scheduler.js";
import type { Review, ReviewSnapshots, SessionCommit, Thread } from "./types";

/**
 * The single reactive source of truth for reviews and their threads, lifted to
 * RepoView and consumed by every surface (ReviewPanel, DiffPanel/diff views,
 * CommitDetail).
 *
 * Threads are a property of the code, not of which pane is open, so they live in
 * one place: one `reviews-changed` subscription, one re-fetch on change. There
 * is no "session is active" concept any more — a repo either has threads to show
 * or it does not.
 */
export interface ReviewCommentsManager {
	/** Threads of the ACTIVE review — the list the panel shows. */
	readonly threads: Thread[];
	/** Every review for this repo, with its derived state and thread count. */
	readonly reviews: Review[];
	readonly activeReviewId: string | null;
	readonly snapshots: ReviewSnapshots;
	/** True when this repo has threads to show. Replaces the session gate. */
	readonly hasThreads: boolean;
	/** The commits in the active review, in the order the backend returned them. */
	readonly commits: SessionCommit[];
	/** Oids of those commits — drives the graph's in-review rail. */
	readonly oids: ReadonlySet<string>;
	/** Advances once per refresh that lands its reads, so consumers can follow. */
	readonly revision: number;
	/** True when the thread read completed with a non-ambiguous active-review batch. */
	readonly threadsAuthoritative: boolean;
	/**
	 * A read failure worth showing, else null. The rune never toasts it — it is
	 * alive for every open tab, and would announce failures for tabs nobody is
	 * looking at. Whoever is on screen decides.
	 */
	readonly lastError: string | null;
	readonly totalCount: number;
	// Derived comment counts shared by every count badge (commit graph, file
	// lists, WIP row). Sourced once here so the graph total always equals the
	// sum of its file badges plus its notes.
	readonly countByCommit: Map<string, number>;
	readonly countByFile: Map<string, number>;
	refresh(): Promise<void>;
	destroy(): void;
}

function firstRealFailure(
	results: PromiseSettledResult<unknown>[],
): string | null {
	for (const result of results) {
		if (result.status !== "rejected") continue;
		return errorMessage(result.reason, "Failed to read the review store");
	}

	return null;
}

export function createReviewComments(
	repoPath: string,
	scheduler: Scheduler = realScheduler,
): ReviewCommentsManager {
	const state = $state({
		threads: [] as Thread[],
		reviews: [] as Review[],
		activeReviewId: null as string | null,
		snapshots: {
			working_tree_snapshot: null,
			index_snapshot: null,
		} as ReviewSnapshots,
		commits: [] as SessionCommit[],
		revision: 0,
		threadsAuthoritative: false,
		lastError: null as string | null,
	});

	const hasThreads = $derived(state.threads.length > 0);

	const oids = $derived(
		new Set(state.commits.map((c) => c.oid)) as ReadonlySet<string>,
	);

	const totalCount = $derived(state.threads.length);

	const counts = $derived(buildCommentCounts(state.threads, state.snapshots));

	// The canonical path the backend reports for this repo. The reviews-changed
	// payload is that canonical string, so the listener filters on it. Tracked
	// separately so the filter can fail-closed while it is still null.
	let canonicalPath: string | null = null;
	let cancelled = false;

	// Generation guard protects this batch from an independent state replacement.
	let loadSeq = 0;

	async function readReviewState(): Promise<void> {
		const seq = ++loadSeq;
		await learnCanonicalPath();
		if (cancelled || seq !== loadSeq) return;

		// allSettled, not all: a read can reject while the repo is closing, and
		// with Promise.all one rejection aborts the whole update, leaving stale
		// threads on screen. Settling each lets a rejection collapse to the
		// correct empty state instead.
		const [reviewsR, activeR, snapshotsR, threadsR, commitsR] =
			await Promise.allSettled([
				safeInvoke<Review[]>("list_reviews", { path: repoPath }),
				safeInvoke<string | null>("get_active_review", { path: repoPath }),
				safeInvoke<ReviewSnapshots>("get_review_snapshots", { path: repoPath }),
				safeInvoke<Thread[]>("list_threads", { path: repoPath }),
				safeInvoke<SessionCommit[]>("list_session_commits", { path: repoPath }),
			]);

		if (cancelled || seq !== loadSeq) return;

		state.reviews =
			reviewsR.status === "fulfilled" && Array.isArray(reviewsR.value)
				? reviewsR.value
				: [];

		state.activeReviewId =
			activeR.status === "fulfilled" ? (activeR.value ?? null) : null;

		const threadBatch =
			threadsR.status === "fulfilled" && Array.isArray(threadsR.value)
				? threadsR.value
				: null;
		const activeReviewReadSucceeded = activeR.status === "fulfilled";
		const activeReviewHasNoThreads =
			state.activeReviewId !== null &&
			state.reviews.some(
				(review) =>
					review.id === state.activeReviewId && review.thread_count === 0,
			);
		const threadBatchMatchesActiveReview =
			activeReviewReadSucceeded &&
			threadBatch !== null &&
			(state.activeReviewId === null
				? threadBatch.length === 0
				: threadBatch.length === 0
					? activeReviewHasNoThreads
					: threadBatch.every(
							(thread) => thread.review_id === state.activeReviewId,
						));

		state.snapshots =
			snapshotsR.status === "fulfilled" && snapshotsR.value
				? snapshotsR.value
				: { working_tree_snapshot: null, index_snapshot: null };

		const threadsAuthoritative = threadBatchMatchesActiveReview;
		state.threadsAuthoritative = threadsAuthoritative;
		state.threads = threadsAuthoritative ? (threadBatch ?? []) : [];

		state.commits =
			commitsR.status === "fulfilled" && Array.isArray(commitsR.value)
				? commitsR.value
				: [];

		state.lastError = firstRealFailure([
			reviewsR,
			activeR,
			snapshotsR,
			threadsR,
			commitsR,
		]);

		state.revision += 1;
	}

	const reviewRefresh = createCoalescedTask(scheduler, readReviewState);
	const stalenessRefresh = createCoalescedTask(scheduler, async () => {
		await safeInvoke("refresh_thread_staleness", { path: repoPath });
	});

	function refresh(): Promise<void> {
		return reviewRefresh.run();
	}

	// Live coordination: refresh when a reviews-changed event arrives for this
	// repo's canonical path. The payload is the canonical path; until one read
	// has reported it, fail closed so cross-repo events during the cold-start
	// window don't trigger a refresh. The `cancelled` flag disposes a listener
	// the promise delivers after destroy().
	const unlisteners: (() => void)[] = [];
	function subscribe(promise: Promise<() => void>): void {
		promise.then((fn) => {
			if (cancelled) fn();
			else unlisteners.push(fn);
		});
	}

	// A string payload is a per-repo emit; a payload-free event is the store
	// poll announcing a foreign commit it can't attribute — refresh ours.
	subscribe(
		listen<string | null>("reviews-changed", (event) => {
			if (!canonicalPath) return;
			if (event.payload != null && event.payload !== canonicalPath) return;
			reviewRefresh.invalidate();
		}),
	);

	// A file changed, so a comment written against a superseded snapshot may
	// have gone stale. The backend decides and stays silent unless a thread
	// actually moved; when one did, its own reviews-changed brings the new
	// rows back through the listener above.
	unlisteners.push(subscribeToRepoChanges(repoPath, stalenessRefresh));

	// Retried on every refresh, not resolved once: a single rejection would
	// otherwise leave the filter failing closed for the rest of the tab's life,
	// so the panel would stop reflecting even its own writes.
	async function learnCanonicalPath(): Promise<void> {
		if (canonicalPath !== null) return;
		try {
			canonicalPath = await safeInvoke<string>("canonical_repo_path", {
				path: repoPath,
			});
		} catch {
			// Left null so the next refresh tries again.
		}
	}

	refresh().catch((error) => console.error("Review refresh failed", error));

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
		get threadsAuthoritative() {
			return state.threadsAuthoritative;
		},
		get lastError() {
			return state.lastError;
		},
		get totalCount() {
			return totalCount;
		},
		get countByCommit() {
			return counts.byCommit;
		},
		get countByFile() {
			return counts.byFile;
		},
		refresh,
		destroy() {
			cancelled = true;
			loadSeq += 1;
			reviewRefresh.dispose();
			stalenessRefresh.dispose();
			for (const unlisten of unlisteners) unlisten();
		},
	};
}
