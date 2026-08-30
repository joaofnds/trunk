import { listen } from "@tauri-apps/api/event";
import { buildCommentCounts } from "./comment-counts.js";
import { errorMessage } from "./error-report.js";
import { safeInvoke } from "./invoke.js";
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

export function createReviewComments(repoPath: string): ReviewCommentsManager {
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

	// Generation guard. Refreshes overlap freely — a reviews-changed burst
	// landing on a manual refresh — and every write below is a whole-state
	// replacement, so a slow older read would otherwise install its snapshot over
	// a newer one. Modelled on BranchSidebar's loadSeq.
	let loadSeq = 0;

	async function refresh(): Promise<void> {
		const seq = ++loadSeq;
		await learnCanonicalPath();

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

		if (seq !== loadSeq) return;

		state.reviews =
			reviewsR.status === "fulfilled" && Array.isArray(reviewsR.value)
				? reviewsR.value
				: [];

		state.activeReviewId =
			activeR.status === "fulfilled" ? (activeR.value ?? null) : null;

		state.snapshots =
			snapshotsR.status === "fulfilled" && snapshotsR.value
				? snapshotsR.value
				: { working_tree_snapshot: null, index_snapshot: null };

		state.threads =
			threadsR.status === "fulfilled" && Array.isArray(threadsR.value)
				? threadsR.value
				: [];

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

	// Live coordination: refresh when a reviews-changed event arrives for this
	// repo's canonical path. The payload is the canonical path; until one read
	// has reported it, fail closed so cross-repo events during the cold-start
	// window don't trigger a refresh. The `cancelled` flag disposes a listener
	// the promise delivers after destroy().
	let unlisten: (() => void) | undefined;
	let cancelled = false;
	// A string payload is a per-repo emit; a payload-free event is the store
	// poll announcing a foreign commit it can't attribute — refresh ours.
	listen<string | null>("reviews-changed", (event) => {
		if (!canonicalPath) return;
		if (event.payload != null && event.payload !== canonicalPath) return;
		refresh().catch(() => {});
	}).then((fn) => {
		if (cancelled) fn();
		else unlisten = fn;
	});

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

	refresh().catch(() => {});

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
			unlisten?.();
		},
	};
}
