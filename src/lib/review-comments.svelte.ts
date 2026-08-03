import { listen } from "@tauri-apps/api/event";
import { buildCommentCounts } from "./comment-counts.js";
import { safeInvoke } from "./invoke.js";
import type {
	Comment,
	ReviewSnapshots,
	SessionCommit,
	SessionStatus,
} from "./types";

/**
 * The single reactive source of truth for review comments, lifted to RepoView
 * and consumed by every surface (ReviewPanel, DiffPanel/diff views, CommitDetail).
 *
 * Comments are a property of the code, not of which pane is open, so they live
 * in one place: one `session-changed` subscription, one re-fetch on change.
 * Visibility is gated on `active` (session status === "active"), independent of
 * the center-pane review toggle (see plan §3, §8).
 */
export interface ReviewCommentsManager {
	readonly comments: Comment[];
	readonly snapshots: ReviewSnapshots;
	readonly active: boolean;
	/** Oids of the commits in the session — drives the graph's in-session rail. */
	readonly oids: ReadonlySet<string>;
	readonly totalCount: number;
	// Derived comment counts shared by every count badge (commit graph, file
	// lists, WIP row). Sourced once here so the graph total always equals the
	// sum of its file badges plus its notes.
	readonly countByCommit: Map<string, number>;
	readonly countByFile: Map<string, number>;
	refresh(): Promise<void>;
	destroy(): void;
}

export function createReviewComments(repoPath: string): ReviewCommentsManager {
	const state = $state({
		comments: [] as Comment[],
		snapshots: {
			working_tree_snapshot: null,
			index_snapshot: null,
		} as ReviewSnapshots,
		active: false,
		oids: new Set<string>() as ReadonlySet<string>,
	});

	const totalCount = $derived(state.comments.length);

	const counts = $derived(buildCommentCounts(state.comments, state.snapshots));

	// The canonical path the backend reports for this repo. The session-changed
	// payload is that canonical string, so the listener filters on it. Tracked
	// separately so the filter can fail-closed while it is still null (a missing
	// or inactive session is a normal state).
	let canonicalPath: string | null = null;

	async function refresh(): Promise<void> {
		// allSettled, not all: list_session_comments rejects with "no_session" once
		// a review ends (review.rs removes the in-memory session), and get_review_*
		// can reject when the repo is closing. With Promise.all a single reject
		// aborts the whole update, leaving stale comments/active on screen — so
		// ending a review would NOT clear inline comments. Settling each lets a
		// rejection collapse to the correct empty/inactive state instead.
		const [statusR, snapshotsR, commentsR, commitsR] = await Promise.allSettled(
			[
				safeInvoke<SessionStatus>("get_review_session_status", {
					path: repoPath,
				}),
				safeInvoke<ReviewSnapshots>("get_review_snapshots", { path: repoPath }),
				safeInvoke<Comment[]>("list_session_comments", { path: repoPath }),
				safeInvoke<SessionCommit[]>("list_session_commits", { path: repoPath }),
			],
		);

		if (statusR.status === "fulfilled" && statusR.value) {
			canonicalPath = statusR.value.canonical_path;
			state.active = statusR.value.state === "active";
		} else {
			state.active = false;
		}

		state.snapshots =
			snapshotsR.status === "fulfilled" && snapshotsR.value
				? snapshotsR.value
				: { working_tree_snapshot: null, index_snapshot: null };

		state.comments =
			commentsR.status === "fulfilled" && Array.isArray(commentsR.value)
				? commentsR.value
				: [];

		state.oids =
			commitsR.status === "fulfilled" && Array.isArray(commitsR.value)
				? new Set(commitsR.value.map((c) => c.oid))
				: new Set();
	}

	// Live coordination: refresh when a session-changed event arrives for this
	// repo's canonical path. Fail-closed when canonicalPath is null so cross-repo
	// events during the cold-start window don't trigger a refresh. The `cancelled`
	// flag disposes a listener the promise delivers after destroy().
	let unlisten: (() => void) | undefined;
	let cancelled = false;
	listen<string>("session-changed", (event) => {
		if (!canonicalPath || event.payload !== canonicalPath) return;
		refresh().catch(() => {});
	}).then((fn) => {
		if (cancelled) fn();
		else unlisten = fn;
	});

	refresh().catch(() => {});

	return {
		get comments() {
			return state.comments;
		},
		get snapshots() {
			return state.snapshots;
		},
		get active() {
			return state.active;
		},
		get oids() {
			return state.oids;
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
