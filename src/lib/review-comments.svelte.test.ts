import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewComments } from "./review-comments.svelte.js";
import type { Comment, SessionCommit } from "./types";

// safeInvoke is a thin wrapper around @tauri-apps/api/core::invoke (src/lib/invoke.ts).
// Mock the underlying invoke (not safeInvoke) so the TrunkError-parsing path stays
// live, matching review-session.svelte.test.ts.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Capture the rune's session-changed callback so tests can simulate a cross-tab
// emit; the real IPC core is undefined under jsdom.
let sessionChangedHandler: ((event: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((_event: string, cb: (event: { payload: string }) => void) => {
		sessionChangedHandler = cb;
		return Promise.resolve(() => {
			sessionChangedHandler = null;
		});
	}),
}));

function fireSessionChanged(payload: string): void {
	sessionChangedHandler?.({ payload });
}

async function flush() {
	await new Promise((r) => setTimeout(r, 0));
}

const mockInvoke = vi.mocked(invoke);

const comment: Comment = {
	id: "c1",
	text: "looks good",
	anchor: {
		commit_oid: "abc",
		file_path: "src/foo.ts",
		source: "Diff",
		side: "New",
		start_line: 10,
		end_line: 10,
	},
	cached_excerpt: null,
	commit_oid: "abc",
};

// Active session: one comment, a working-tree snapshot.
function activeSession() {
	mockInvoke.mockImplementation((cmd: string) => {
		switch (cmd) {
			case "get_review_session_status":
				return Promise.resolve({
					state: "active",
					file_exists: true,
					canonical_path: "/repo",
				});
			case "get_review_snapshots":
				return Promise.resolve({
					working_tree_snapshot: "wt1",
					index_snapshot: null,
				});
			case "list_session_comments":
				return Promise.resolve([comment]);
			case "list_session_commits":
				return Promise.resolve([
					{
						oid: "abc",
						short_oid: "abc",
						summary: "a commit under review",
						is_snapshot: false,
					},
				]);
			default:
				return Promise.reject(new Error(`unexpected ${cmd}`));
		}
	});
}

// After End Review the backend removes the in-memory session, so
// list_session_comments rejects with no_session and status reports "none".
function endedSession() {
	mockInvoke.mockImplementation((cmd: string) => {
		switch (cmd) {
			case "get_review_session_status":
				return Promise.resolve({
					state: "none",
					file_exists: false,
					canonical_path: "/repo",
				});
			case "get_review_snapshots":
				return Promise.resolve({
					working_tree_snapshot: null,
					index_snapshot: null,
				});
			case "list_session_comments":
			case "list_session_commits":
				return Promise.reject(
					'{"code":"no_session","message":"No active review session for this repository"}',
				);
			default:
				return Promise.reject(new Error(`unexpected ${cmd}`));
		}
	});
}

// A session saved on disk but not yet in memory: status reports
// "resume-available" and the list reads reject with no_session until it is
// promoted.
function resumableSession() {
	mockInvoke.mockImplementation((cmd: string) => {
		switch (cmd) {
			case "get_review_session_status":
				return Promise.resolve({
					state: "resume-available",
					file_exists: true,
					canonical_path: "/repo",
				});
			case "get_review_snapshots":
				return Promise.resolve({
					working_tree_snapshot: null,
					index_snapshot: null,
				});
			case "list_session_comments":
			case "list_session_commits":
				return Promise.reject(
					'{"code":"no_session","message":"No active review session for this repository"}',
				);
			default:
				return Promise.reject(new Error(`unexpected ${cmd}`));
		}
	});
}

// A repo the backend will not answer for: every read rejects, so the rune never
// learns a canonical path.
function unreachableRepo() {
	mockInvoke.mockImplementation(() =>
		Promise.reject('{"code":"not_open","message":"Repository is not open"}'),
	);
}

beforeEach(() => {
	mockInvoke.mockReset();
});

describe("createReviewComments — refresh", () => {
	it("populates comments, snapshots and active from a successful refresh", async () => {
		activeSession();
		const m = createReviewComments("/repo");

		await m.refresh();

		expect(m.comments).toEqual([comment]);
		expect(m.snapshots).toEqual({
			working_tree_snapshot: "wt1",
			index_snapshot: null,
		});
		expect(m.active).toBe(true);

		m.destroy();
	});

	it("exposes the oids of the commits under review", async () => {
		activeSession();
		const m = createReviewComments("/repo");

		await m.refresh();

		expect([...m.oids]).toEqual(["abc"]);

		m.destroy();
	});

	it("empties the oids when the session ends", async () => {
		activeSession();
		const m = createReviewComments("/repo");
		await m.refresh();

		endedSession();
		await m.refresh();

		expect(m.oids.size).toBe(0);

		m.destroy();
	});

	it("clears stale comments and marks inactive when the session ends", async () => {
		activeSession();
		const m = createReviewComments("/repo");
		await m.refresh();
		expect(m.comments).toHaveLength(1);
		expect(m.active).toBe(true);

		// Regression: a naive Promise.all would let the no_session rejection abort
		// the whole update, leaving the stale comment (and active=true) on screen,
		// so inline comments would not vanish on End Review.
		endedSession();
		await m.refresh();

		expect(m.comments).toEqual([]);
		expect(m.active).toBe(false);
		expect(m.snapshots).toEqual({
			working_tree_snapshot: null,
			index_snapshot: null,
		});

		m.destroy();
	});

	it("carries the commits under review in session order", async () => {
		const underReview: SessionCommit[] = [
			{
				oid: "abc",
				short_oid: "abcdefg",
				summary: "first commit",
				is_snapshot: false,
			},
			{
				oid: "def",
				short_oid: "defabcd",
				summary: "second commit",
				is_snapshot: true,
			},
		];
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "list_session_commits"
				? Promise.resolve(underReview)
				: Promise.resolve(undefined),
		);
		const m = createReviewComments("/repo");

		await m.refresh();

		expect(m.commits).toEqual(underReview);

		m.destroy();
	});

	it("distinguishes a session saved on disk from no session at all", async () => {
		resumableSession();
		const m = createReviewComments("/repo");

		await m.refresh();

		expect(m.sessionState).toBe("resume-available");
		expect(m.active).toBe(false);

		m.destroy();
	});

	it("goes dark when the status read fails", async () => {
		activeSession();
		const m = createReviewComments("/repo");
		await m.refresh();
		expect(m.sessionState).toBe("active");

		unreachableRepo();
		await m.refresh();

		expect(m.active).toBe(false);
		expect(m.sessionState).toBe("none");

		m.destroy();
	});
});

describe("createReviewComments — session-changed listener", () => {
	it("refreshes on an event for its own repo", async () => {
		activeSession();
		const m = createReviewComments("/repo");
		await flush();

		endedSession();
		fireSessionChanged("/repo");
		await flush();

		expect(m.active).toBe(false);
		expect(m.comments).toEqual([]);

		m.destroy();
	});

	it("ignores an event for another repo", async () => {
		activeSession();
		const m = createReviewComments("/repo");
		await flush();

		endedSession();
		fireSessionChanged("/some/other/repo");
		await flush();

		expect(m.active).toBe(true);
		expect(m.comments).toEqual([comment]);

		m.destroy();
	});

	it("drops every event while the canonical path is unknown", async () => {
		unreachableRepo();
		const m = createReviewComments("/repo");
		await flush();

		activeSession();
		fireSessionChanged("/some/other/repo");
		await flush();

		expect(m.active).toBe(false);

		m.destroy();
	});
});

describe("createReviewComments — overlapping refreshes", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	it("keeps the newest result when an older refresh resolves last", async () => {
		const older = deferred<Comment[]>();
		const newer = deferred<Comment[]>();
		let commentReads = 0;
		mockInvoke.mockImplementation((cmd: string) => {
			switch (cmd) {
				case "get_review_session_status":
					return Promise.resolve({
						state: "active",
						file_exists: true,
						canonical_path: "/repo",
					});
				case "get_review_snapshots":
					return Promise.resolve({
						working_tree_snapshot: null,
						index_snapshot: null,
					});
				case "list_session_comments":
					return (commentReads++ === 0 ? older : newer).promise;
				default:
					return Promise.resolve([]);
			}
		});

		const m = createReviewComments("/repo");
		const second = m.refresh();
		newer.resolve([comment]);
		await second;
		older.resolve([]);
		await flush();

		expect(m.comments).toEqual([comment]);

		m.destroy();
	});
});
