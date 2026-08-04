import { buildCommentCounts } from "../../lib/comment-counts.js";
import type { ReviewCommentsManager } from "../../lib/review-comments.svelte.js";
import type {
	Comment,
	ReviewSnapshots,
	SessionCommit,
	SessionState,
} from "../../lib/types.js";

interface Session {
	comments: Comment[];
	snapshots: ReviewSnapshots;
	sessionState: SessionState;
	commits: SessionCommit[];
	lastError: string | null;
}

export interface FakeReviewComments extends ReviewCommentsManager {
	/**
	 * Stage the next session. Nothing a consumer can observe changes until
	 * refresh() runs — the real rune only publishes what a round trip returned,
	 * so a Fake that published on seed would hide every missing-refresh bug.
	 */
	seed(next: Partial<Session>): void;
	reset(): void;
	readonly refreshCount: number;
}

function emptySession(): Session {
	return {
		comments: [],
		snapshots: { working_tree_snapshot: null, index_snapshot: null },
		sessionState: "none",
		commits: [],
		lastError: null,
	};
}

export function createFakeReviewComments(): FakeReviewComments {
	let seeded = emptySession();
	let refreshCount = 0;

	const state = $state({ ...emptySession(), revision: 0 });

	const active = $derived(state.sessionState === "active");

	const oids = $derived(
		new Set(state.commits.map((c) => c.oid)) as ReadonlySet<string>,
	);

	const counts = $derived(buildCommentCounts(state.comments, state.snapshots));

	return {
		get comments() {
			return state.comments;
		},
		get snapshots() {
			return state.snapshots;
		},
		get sessionState() {
			return state.sessionState;
		},
		get active() {
			return active;
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
			return state.comments.length;
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
			state.comments = seeded.comments;
			state.snapshots = seeded.snapshots;
			state.sessionState = seeded.sessionState;
			state.commits = seeded.commits;
			state.lastError = seeded.lastError;
			state.revision += 1;
			return Promise.resolve();
		},
		destroy() {},
		seed(next: Partial<Session>) {
			seeded = { ...seeded, ...next };
		},
		reset() {
			seeded = emptySession();
			Object.assign(state, emptySession(), { revision: 0 });
			refreshCount = 0;
		},
	};
}
