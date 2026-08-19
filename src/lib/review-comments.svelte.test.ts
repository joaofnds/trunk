import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { createReviewComments } from "./review-comments.svelte.js";
import type { Review, SessionCommit, Thread } from "./types";

// safeInvoke is a thin wrapper around @tauri-apps/api/core::invoke
// (src/lib/invoke.ts). Mock the underlying invoke (not safeInvoke) so the
// TrunkError-parsing path stays live.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Capture the rune's reviews-changed callback so tests can simulate a cross-tab
// emit; the real IPC core is undefined under jsdom.
let reviewsChangedHandler: ((event: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((_event: string, cb: (event: { payload: string }) => void) => {
		reviewsChangedHandler = cb;
		return Promise.resolve(() => {
			reviewsChangedHandler = null;
		});
	}),
}));

function fireReviewsChanged(payload: string): void {
	reviewsChangedHandler?.({ payload });
}

async function flush() {
	await new Promise((r) => setTimeout(r, 0));
}

const mockInvoke = vi.mocked(invoke);

const thread: Thread = aThread({
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
	commit_oid: "abc",
});

const review: Review = {
	id: "REVIEW01",
	title: "Review 2026-08-12 · REVIEW01",
	state: "composing",
	published: false,
	thread_count: 1,
	created_at: 0,
};

const commits: SessionCommit[] = [
	{ oid: "abc", short_oid: "abc", summary: "one", is_snapshot: false },
];

/** A repo with one composing review holding one thread. */
function aPopulatedStore(overrides: Record<string, unknown> = {}) {
	mockInvoke.mockImplementation((cmd: string) => {
		if (cmd in overrides) return Promise.resolve(overrides[cmd]);
		switch (cmd) {
			case "list_reviews":
				return Promise.resolve([review]);
			case "get_active_review":
				return Promise.resolve("REVIEW01");
			case "get_review_snapshots":
				return Promise.resolve({
					working_tree_snapshot: "wt1",
					index_snapshot: null,
				});
			case "list_threads":
				return Promise.resolve([thread]);
			case "list_session_commits":
				return Promise.resolve(commits);
			case "canonical_repo_path":
				return Promise.resolve("/repo");
			default:
				return Promise.resolve(undefined);
		}
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	reviewsChangedHandler = null;
});

describe("createReviewComments — refresh", () => {
	it("populates threads, reviews, the active pointer and snapshots", async () => {
		aPopulatedStore();

		const manager = createReviewComments("/repo");
		await flush();

		expect(manager.threads).toHaveLength(1);
		expect(manager.reviews).toHaveLength(1);
		expect(manager.activeReviewId).toBe("REVIEW01");
		expect(manager.snapshots.working_tree_snapshot).toBe("wt1");
		manager.destroy();
	});

	it("reports having threads to show, which is what every badge gates on", async () => {
		aPopulatedStore();

		const manager = createReviewComments("/repo");
		await flush();

		expect(manager.hasThreads).toBe(true);
		manager.destroy();
	});

	it("has nothing to show for a repo with reviews but no threads", async () => {
		aPopulatedStore({ list_threads: [] });

		const manager = createReviewComments("/repo");
		await flush();

		expect(manager.hasThreads).toBe(false);
		expect(manager.reviews).toHaveLength(1);
		manager.destroy();
	});

	it("exposes the oids of the active review's commits", async () => {
		aPopulatedStore();

		const manager = createReviewComments("/repo");
		await flush();

		expect(manager.oids.has("abc")).toBe(true);
		manager.destroy();
	});

	it("empties everything for a repo with no reviews at all", async () => {
		aPopulatedStore({
			list_reviews: [],
			get_active_review: null,
			list_threads: [],
			list_session_commits: [],
		});

		const manager = createReviewComments("/repo");
		await flush();

		expect(manager.threads).toHaveLength(0);
		expect(manager.activeReviewId).toBeNull();
		expect(manager.hasThreads).toBe(false);
		expect(manager.oids.size).toBe(0);
		manager.destroy();
	});

	// Scoped by command, never with a bare mockImplementationOnce: the rune also
	// reads canonical_repo_path, which would consume a one-shot override before
	// any refresh read saw it.
	function failing(cmd: string) {
		aPopulatedStore();
		const base = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation((c, args, options) =>
			c === cmd
				? Promise.reject('{"code":"store","message":"database is locked"}')
				: (base?.(c, args, options) ?? Promise.resolve(undefined)),
		);
	}

	it("reports a read failure rather than swallowing it", async () => {
		failing("list_threads");

		const manager = createReviewComments("/repo");
		await flush();

		expect(manager.lastError).toContain("database is locked");
		manager.destroy();
	});

	it("clears a read failure once a refresh comes back clean", async () => {
		failing("list_threads");
		const manager = createReviewComments("/repo");
		await flush();
		expect(manager.lastError).not.toBeNull();

		aPopulatedStore();
		await manager.refresh();

		expect(manager.lastError).toBeNull();
		manager.destroy();
	});
});

describe("createReviewComments — reviews-changed listener", () => {
	it("refreshes on an event for its own repo", async () => {
		aPopulatedStore();
		const manager = createReviewComments("/repo");
		await flush();
		const before = manager.revision;

		fireReviewsChanged("/repo");
		await flush();

		expect(manager.revision).toBeGreaterThan(before);
		manager.destroy();
	});

	it("ignores an event for another repo", async () => {
		aPopulatedStore();
		const manager = createReviewComments("/repo");
		await flush();
		const before = manager.revision;

		fireReviewsChanged("/somewhere-else");
		await flush();

		expect(manager.revision).toBe(before);
		manager.destroy();
	});

	it("recovers the filter when a later canonical-path read succeeds", async () => {
		// One rejection used to disable the listener for the tab's lifetime.
		aPopulatedStore();
		let attempts = 0;
		const base = mockInvoke.getMockImplementation();
		mockInvoke.mockImplementation((c, args, options) => {
			if (c === "canonical_repo_path") {
				attempts += 1;
				return attempts === 1
					? Promise.reject('{"code":"io","message":"transient"}')
					: Promise.resolve("/repo");
			}
			return base?.(c, args, options) ?? Promise.resolve(undefined);
		});
		const manager = createReviewComments("/repo");
		await flush();

		await manager.refresh();
		const before = manager.revision;
		fireReviewsChanged("/repo");
		await flush();

		expect(manager.revision).toBeGreaterThan(before);
		manager.destroy();
	});

	it("drops every event while the canonical path is still unknown", async () => {
		// The canonical path never resolves, so the filter must fail closed
		// rather than treat an unknown path as a match.
		aPopulatedStore({ canonical_repo_path: undefined });
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "canonical_repo_path") return new Promise(() => {});
			return Promise.resolve(cmd === "list_reviews" ? [review] : []);
		});
		const manager = createReviewComments("/repo");
		await flush();
		const before = manager.revision;

		fireReviewsChanged("/repo");
		await flush();

		expect(manager.revision).toBe(before);
		manager.destroy();
	});
});

describe("createReviewComments — overlapping refreshes", () => {
	it("keeps the newest result when an older refresh resolves last", async () => {
		// Two refreshes in flight, each blocked on its own list_threads. The
		// older one resolves last and must not install its snapshot over the
		// newer one.
		const gates: ((value: Thread[]) => void)[] = [];
		mockInvoke.mockImplementation((cmd: string) => {
			switch (cmd) {
				case "list_reviews":
					return Promise.resolve([review]);
				case "get_active_review":
					return Promise.resolve("REVIEW01");
				case "list_threads":
					return new Promise<Thread[]>((resolve) => gates.push(resolve));
				case "canonical_repo_path":
					return Promise.resolve("/repo");
				default:
					return Promise.resolve([]);
			}
		});

		const manager = createReviewComments("/repo");
		await flush();
		const second = manager.refresh();
		await flush();

		// Resolve the NEWER read first, then let the older one land.
		gates[1]?.([thread]);
		await second;
		gates[0]?.([]);
		await flush();

		expect(manager.threads).toHaveLength(1);
		manager.destroy();
	});
});
