import { listen } from "@tauri-apps/api/event";
import { createCoalescedTask } from "./coalesced-task.js";
import { errorMessage } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
import { subscribeToRepoChanges } from "./repo-change-subscription.js";
import { realScheduler, type Scheduler } from "./scheduler.js";
import type { Review, ReviewSnapshots, SessionCommit, Thread } from "./types";

export type ReviewReadState = "ready" | "pending" | "failed";

type SelectedRead =
	| { reviewId: string; readState: "pending" | "failed" }
	| {
			reviewId: string;
			readState: "ready";
			threads: Thread[];
			commits: SessionCommit[];
	  };

interface ShownRead {
	readState: ReviewReadState;
	threads: Thread[];
	commits: SessionCommit[];
}

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
	/** Threads of the active review, where new comments land. */
	readonly threads: Thread[];
	/** Every review for this repo, with its derived state and thread count. */
	readonly reviews: Review[];
	readonly activeReviewId: string | null;
	/** The review new comments land in, or null while the list lacks it. */
	readonly activeReview: Review | null;
	/**
	 * The review the panel shows: the last selection until a list read begun
	 * with that selection proves it gone, else the active one. Selecting never
	 * moves where new comments land.
	 */
	readonly shownReviewId: string | null;
	readonly shownReview: Review | null;
	readonly shownThreads: Thread[];
	readonly shownCommits: SessionCommit[];
	/**
	 * Where the read behind shownThreads and shownCommits stands. Both are
	 * empty until it is ready.
	 */
	readonly shownReadState: ReviewReadState;
	/**
	 * The threads the review-mode diff draws: a picked review's once read, and
	 * the active review's even when another of its reads failed. An unresolved
	 * pick never draws another review's threads.
	 */
	readonly diffThreads: Thread[];
	readonly snapshots: ReviewSnapshots;
	/** True when this repo has threads to show. Replaces the session gate. */
	readonly hasThreads: boolean;
	/** The commits in the active review, in the order the backend returned them. */
	readonly commits: SessionCommit[];
	/** Oids of the commits someone added, which drive the graph's in-review rail. */
	readonly oids: ReadonlySet<string>;
	/** Advances once per refresh that lands its reads, so consumers can follow. */
	readonly revision: number;
	/** Which repository inputs the accepted refresh changed. */
	readonly revisionScope: "full" | "refs";
	/** True when the thread read completed with a non-ambiguous active-review batch. */
	readonly threadsAuthoritative: boolean;
	/**
	 * A read failure worth showing, else null. The rune never toasts it — it is
	 * alive for every open tab, and would announce failures for tabs nobody is
	 * looking at. Whoever is on screen decides.
	 */
	readonly lastError: string | null;
	readonly totalCount: number;
	select(reviewId: string): Promise<void>;
	refresh(): Promise<void>;
	setActive(active: boolean): void;
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
		selectedReviewId: null as string | null,
		selected: null as SelectedRead | null,
		selectedError: null as string | null,
		activeReadState: "pending" as ReviewReadState,
		revision: 0,
		revisionScope: "full" as "full" | "refs",
		threadsAuthoritative: false,
		refreshError: null as string | null,
	});

	const hasThreads = $derived(state.threads.length > 0);
	const activeReview = $derived(
		state.reviews.find((review) => review.id === state.activeReviewId) ?? null,
	);

	const shownReviewId = $derived(
		state.selectedReviewId ?? state.activeReviewId,
	);
	const shownReview = $derived(
		state.reviews.find((review) => review.id === shownReviewId) ?? null,
	);
	const shown = $derived.by((): ShownRead => {
		const selected = state.selected;
		if (
			selected?.reviewId === shownReviewId &&
			selected.readState === "pending"
		)
			return { readState: "pending", threads: [], commits: [] };
		if (shownReviewId === state.activeReviewId) {
			if (state.activeReadState !== "ready")
				return { readState: state.activeReadState, threads: [], commits: [] };
			return {
				readState: "ready",
				threads: state.threads,
				commits: state.commits,
			};
		}

		if (selected === null || selected.reviewId !== shownReviewId)
			return { readState: "pending", threads: [], commits: [] };
		if (selected.readState !== "ready")
			return { readState: selected.readState, threads: [], commits: [] };
		return {
			readState: "ready",
			threads: selected.threads,
			commits: selected.commits,
		};
	});

	const diffThreads = $derived.by((): Thread[] => {
		if (shownReviewId !== state.activeReviewId) return shown.threads;
		return state.threads;
	});

	const oids = $derived(
		new Set(
			state.commits.filter((c) => c.picked).map((c) => c.oid),
		) as ReadonlySet<string>,
	);

	const totalCount = $derived(state.threads.length);

	// The canonical path the backend reports for this repo. The reviews-changed
	// payload is that canonical string, so the listener filters on it. Tracked
	// separately so the filter can fail-closed while it is still null.
	let canonicalPath: string | null = null;
	let cancelled = false;

	// An earlier selection can finish after a newer click, including a return to the same review.
	let choiceRevision = 0;
	let selectedRead: { reviewId: string } | null = null;
	let activeSelectedReads = 0;
	let waitingForSlot: ((admitted: boolean) => void) | null = null;
	let picking: { reviewId: string; done: Promise<void> } | null = null;
	let fullRefreshPending = true;
	let runningScope: "full" | "refs" | null = null;

	async function readReviewState(): Promise<void> {
		const scope = fullRefreshPending ? "full" : "refs";
		fullRefreshPending = false;
		runningScope = scope;
		const choiceAtStart = choiceRevision;
		const selectedAtStart = selectedRead;
		if (state.selected?.readState === "failed")
			state.selected = {
				reviewId: state.selected.reviewId,
				readState: "pending",
			};
		if (state.activeReadState === "failed") state.activeReadState = "pending";
		await learnCanonicalPath();
		if (cancelled) return;

		// allSettled, not all: a read can reject while the repo is closing, and
		// with Promise.all one rejection aborts the whole update, leaving stale
		// threads on screen. Settling each lets a rejection collapse to empty
		// and mark the read failed instead.
		const [[reviewsR, activeR, snapshotsR], [threadsR, commitsR]] =
			await Promise.all([
				Promise.allSettled([
					safeInvoke<Review[]>("list_reviews", { path: repoPath }),
					safeInvoke<string | null>("get_active_review", { path: repoPath }),
					safeInvoke<ReviewSnapshots>("get_review_snapshots", {
						path: repoPath,
					}),
				]),
				readDetails(),
			]);
		const activeId =
			activeR.status === "fulfilled" ? (activeR.value ?? null) : null;

		if (cancelled) return;

		const reviewList =
			reviewsR.status === "fulfilled" && Array.isArray(reviewsR.value)
				? reviewsR.value
				: null;
		if (reviewList !== null) state.reviews = reviewList;
		const pick = state.selectedReviewId;
		const sameChoice = choiceAtStart === choiceRevision;
		const pickWasDeleted =
			reviewList !== null &&
			pick !== null &&
			sameChoice &&
			!reviewList.some((review) => review.id === pick);
		if (pickWasDeleted) state.selectedReviewId = null;

		const previousActiveId = state.activeReviewId;
		state.activeReviewId = activeId;

		const threadBatch =
			threadsR.status === "fulfilled" && Array.isArray(threadsR.value)
				? threadsR.value
				: null;
		const activeReviewReadSucceeded = activeR.status === "fulfilled";
		const activeReviewHasNoThreads =
			state.activeReviewId !== null &&
			reviewList?.some(
				(review) =>
					review.id === state.activeReviewId && review.thread_count === 0,
			) === true;
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

		state.activeReadState = [reviewsR, activeR, threadsR, commitsR].some(
			(result) => result.status === "rejected",
		)
			? "failed"
			: "ready";

		state.refreshError = firstRealFailure([
			reviewsR,
			activeR,
			snapshotsR,
			threadsR,
			commitsR,
		]);
		if (pickWasDeleted || pick === null || pick === state.activeReviewId) {
			if (
				pick === activeId &&
				selectedRead?.reviewId === pick &&
				selectedRead !== selectedAtStart
			) {
				// Selection and the active pointer converged. Only a successful newer
				// named read can supersede the implicit detail snapshot.
				useSelectedDetailsForActiveReview();
			} else {
				clearSelectedRead();
			}
		} else if (sameChoice && reviewList === null) {
			// A failed listing cannot prove that the selected review was deleted.
			selectedRead = null;
			state.selected = { reviewId: pick, readState: "failed" };
			state.selectedError = state.refreshError;
		} else if (!state.reviews.some((review) => review.id === pick)) {
			// This list predates the click. Only a subsequent read can retire that pick.
			fullRefreshPending = true;
			reviewRefresh.invalidate();
		} else if (sameChoice || pick === previousActiveId) {
			// A known pick made during this refresh already started its own read,
			// except when it could use the review that was active at the time.
			await readSelectedReview(pick);
			if (cancelled) return;
		}
		state.revisionScope = scope;
		state.revision += 1;
		runningScope = null;
	}

	function readDetails(reviewId?: string) {
		const args =
			reviewId === undefined
				? { path: repoPath }
				: { path: repoPath, reviewId };
		return Promise.allSettled([
			safeInvoke<Thread[]>("list_threads", args),
			safeInvoke<SessionCommit[]>("list_session_commits", args),
		]);
	}

	function useSelectedDetailsForActiveReview(): void {
		const selected = state.selected;
		if (
			selected?.readState !== "ready" ||
			selected.reviewId !== state.activeReviewId
		)
			return;
		state.threads = selected.threads;
		state.threadsAuthoritative = true;
		state.commits = selected.commits;
		state.activeReadState = "ready";
	}

	function clearSelectedRead(): void {
		state.selected = null;
		state.selectedError = null;
		selectedRead = null;
		waitingForSlot?.(false);
		waitingForSlot = null;
	}

	async function readSelectedReview(reviewId: string): Promise<void> {
		const request = { reviewId };
		selectedRead = request;
		if (state.selected?.readState !== "ready")
			state.selected = { reviewId, readState: "pending" };
		// Two slots let a new pick overtake a slow one. Once both are busy,
		// replace the waiting pick, since only the last choice will be shown.
		if (activeSelectedReads === 2) {
			waitingForSlot?.(false);
			const admitted = await new Promise<boolean>((resolve) => {
				waitingForSlot = resolve;
			});
			if (!admitted) return;
		} else {
			activeSelectedReads += 1;
		}
		try {
			if (cancelled || request !== selectedRead) return;
			const results = await readDetails(reviewId);
			if (cancelled || request !== selectedRead) return;
			const [threadsR, commitsR] = results;
			state.selectedError = firstRealFailure(results);
			if (threadsR.status === "rejected" || commitsR.status === "rejected") {
				state.selected = { reviewId, readState: "failed" };
				return;
			}
			state.selected = {
				reviewId,
				readState: "ready",
				threads: Array.isArray(threadsR.value) ? threadsR.value : [],
				commits: Array.isArray(commitsR.value) ? commitsR.value : [],
			};
			useSelectedDetailsForActiveReview();
		} finally {
			if (waitingForSlot) {
				// Transfer this slot directly to the latest waiting read.
				waitingForSlot(true);
				waitingForSlot = null;
			} else {
				activeSelectedReads -= 1;
			}
		}
	}

	const reviewRefresh = createCoalescedTask(scheduler, readReviewState);
	const stalenessRefresh = createCoalescedTask(scheduler, async () => {
		await safeInvoke("refresh_thread_staleness", { path: repoPath });
	});
	let active = true;
	let refsPending = false;
	const refStalenessRefresh = createCoalescedTask(scheduler, async () => {
		if (!active || !refsPending) return;

		refsPending = false;
		try {
			await safeInvoke("refresh_thread_ref_staleness", { path: repoPath });
		} catch (error) {
			refsPending = true;
			throw error;
		}

		if (cancelled) return;

		if (!active) {
			refsPending = true;
			return;
		}

		fullRefreshPending ||= runningScope === "full";
		reviewRefresh.invalidate();
	});

	function setActive(value: boolean): void {
		active = value;
		if (active && refsPending) refStalenessRefresh.invalidate();
	}

	function refresh(): Promise<void> {
		fullRefreshPending = true;
		return reviewRefresh.run();
	}

	function chooseReview(reviewId: string): Promise<void> {
		const reselected = reviewId === shownReviewId;
		choiceRevision += 1;
		if (state.selectedReviewId !== reviewId) clearSelectedRead();
		state.selectedReviewId = reviewId;
		if (
			reselected ||
			state.refreshError !== null ||
			canonicalPath === null ||
			!state.reviews.some((review) => review.id === reviewId)
		)
			return refresh();
		if (reviewId === state.activeReviewId) {
			return state.activeReadState === "ready" && state.threadsAuthoritative
				? Promise.resolve()
				: refresh();
		}
		return readSelectedReview(reviewId);
	}

	function select(reviewId: string): Promise<void> {
		if (picking?.reviewId === reviewId) return picking.done;
		const choice = { reviewId, done: chooseReview(reviewId) };
		picking = choice;
		return choice.done.finally(() => {
			if (picking === choice) picking = null;
		});
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
			fullRefreshPending = true;
			reviewRefresh.invalidate();
		}),
	);

	unlisteners.push(
		subscribeToRepoChanges(repoPath, {
			includeRefs: true,
			async run() {
				await stalenessRefresh.run();
				if (cancelled) return;

				fullRefreshPending = true;
				await reviewRefresh.run();
			},
			invalidate(event) {
				if (event.refs_only) {
					refsPending = true;
					if (active) refStalenessRefresh.invalidate();
				} else stalenessRefresh.invalidate();
			},
		}),
	);

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
	stalenessRefresh.invalidate();

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
		get shownReadState() {
			return shown.readState;
		},
		get diffThreads() {
			return diffThreads;
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
		get revisionScope() {
			return state.revisionScope;
		},
		get threadsAuthoritative() {
			return state.threadsAuthoritative;
		},
		get lastError() {
			return state.refreshError ?? state.selectedError;
		},
		get totalCount() {
			return totalCount;
		},
		select,
		refresh,
		setActive,
		destroy() {
			cancelled = true;
			clearSelectedRead();
			reviewRefresh.dispose();
			stalenessRefresh.dispose();
			refStalenessRefresh.dispose();
			for (const unlisten of unlisteners) unlisten();
		},
	};
}
