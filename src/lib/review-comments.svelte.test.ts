import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	createReviewComments,
	type ReviewCommentsManager,
} from "./review-comments.svelte.js";
import type { Scheduler } from "./scheduler.js";
import type { Review, SessionCommit, Thread } from "./types";

// safeInvoke is a thin wrapper around @tauri-apps/api/core::invoke
// (src/lib/invoke.ts). Mock the underlying invoke (not safeInvoke) so the
// TrunkError-parsing path stays live.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Capture the rune's event callbacks by name so tests can simulate a cross-tab
// emit or a filesystem change; the real IPC core is undefined under jsdom.
const handlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
		handlers.set(name, cb);
		return Promise.resolve(() => {
			handlers.delete(name);
		});
	}),
}));

class TestScheduler implements Scheduler {
	private callbacks: Array<() => void> = [];
	private nextHandle = 1;

	currentTimeMs(): number {
		return 0;
	}

	setTimeout(callback: () => void, _delayMs: number): number {
		this.callbacks.push(callback);
		return this.nextHandle++;
	}

	clearTimeout(_handle: number): void {}

	flush(): void {
		const callbacks = this.callbacks;
		this.callbacks = [];
		for (const callback of callbacks) callback();
	}
}

let scheduler = new TestScheduler();

function fireReviewsChanged(payload: string | null): void {
	handlers.get("reviews-changed")?.({ payload });
}

function fireRepoChanged(repo: string): void {
	handlers.get("repo-changed")?.({ payload: { repo, paths: [] } });
}

async function flush() {
	scheduler.flush();
	await new Promise((r) => setTimeout(r, 0));
}

const mockInvoke = vi.mocked(invoke);

function overrideReads(
	route: (cmd: string, reviewId: unknown) => Promise<unknown> | undefined,
) {
	const answering = mockInvoke.getMockImplementation();
	mockInvoke.mockImplementation(
		(cmd, args, options) =>
			route(cmd, args && "reviewId" in args ? args.reviewId : undefined) ??
			answering?.(cmd, args, options) ??
			Promise.resolve(undefined),
	);
}

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
	title: "Review 2026-08-12",
	state: "settled",
	visible_to_agent: false,
	archived: false,
	thread_count: 1,
	unresolved_count: 1,
	pending_count: 0,
	created_at: 0,
};

const commits: SessionCommit[] = [
	aSessionCommit({ oid: "abc", short_oid: "abc", summary: "one" }),
];

/** A repo with one review holding one thread. */
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
	handlers.clear();
	scheduler = new TestScheduler();
});

describe("createReviewComments — refresh", () => {
	it("populates threads, reviews, the active pointer and snapshots", async () => {
		aPopulatedStore();

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.threads).toHaveLength(1);
		expect(manager.threadsAuthoritative).toBe(true);
		expect(manager.reviews).toHaveLength(1);
		expect(manager.activeReviewId).toBe("REVIEW01");
		expect(manager.snapshots.working_tree_snapshot).toBe("wt1");
		manager.destroy();
	});

	it("reports having threads to show, which is what every badge gates on", async () => {
		aPopulatedStore();

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.hasThreads).toBe(true);
		manager.destroy();
	});

	it("has nothing to show for a repo with reviews but no threads", async () => {
		aPopulatedStore({ list_threads: [] });

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.hasThreads).toBe(false);
		expect(manager.threadsAuthoritative).toBe(false);
		expect(manager.reviews).toHaveLength(1);
		manager.destroy();
	});

	it("accepts an empty batch for an active review with no threads", async () => {
		aPopulatedStore({
			list_reviews: [{ ...review, thread_count: 0 }],
			list_threads: [],
		});

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.threads).toHaveLength(0);
		expect(manager.threadsAuthoritative).toBe(true);
		manager.destroy();
	});

	it("exposes the oids of the active review's commits", async () => {
		aPopulatedStore();

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.oids.has("abc")).toBe(true);
		manager.destroy();
	});

	it("leaves a commit only a thread names out of the oids", async () => {
		aPopulatedStore({
			list_session_commits: [
				...commits,
				aSessionCommit({ oid: "def", picked: false }),
			],
		});

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect([...manager.oids]).toEqual(["abc"]);
		manager.destroy();
	});

	it("empties everything for a repo with no reviews at all", async () => {
		aPopulatedStore({
			list_reviews: [],
			get_active_review: null,
			list_threads: [],
			list_session_commits: [],
		});

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.threads).toHaveLength(0);
		expect(manager.activeReviewId).toBeNull();
		expect(manager.hasThreads).toBe(false);
		expect(manager.threadsAuthoritative).toBe(true);
		expect(manager.oids.size).toBe(0);
		manager.destroy();
	});

	// Scoped by command, never with a bare mockImplementationOnce: the rune also
	// reads canonical_repo_path, which would consume a one-shot override before
	// any refresh read saw it.
	function failing(cmd: string) {
		aPopulatedStore();
		overrideReads((c) =>
			c === cmd
				? Promise.reject('{"code":"store","message":"database is locked"}')
				: undefined,
		);
	}

	it("reports a read failure rather than swallowing it", async () => {
		failing("list_threads");

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.lastError).toContain("database is locked");
		expect(manager.threadsAuthoritative).toBe(false);
		manager.destroy();
	});

	describe("shownReadState of the active review", () => {
		/** Holds every later read of the active review's threads. */
		function holdActiveThreads() {
			overrideReads((cmd, reviewId) =>
				reviewId === undefined && cmd === "list_threads"
					? new Promise<Thread[]>(() => {})
					: undefined,
			);
		}

		it("is ready once the first read lands", async () => {
			aPopulatedStore();

			const manager = createReviewComments("/repo", scheduler);
			await flush();

			expect(manager.shownReadState).toBe("ready");
			manager.destroy();
		});

		it("is pending until the first read lands", async () => {
			aPopulatedStore();
			holdActiveThreads();

			const manager = createReviewComments("/repo", scheduler);
			await flush();

			expect(manager.shownReadState).toBe("pending");
			manager.destroy();
		});

		it("stays ready with its threads while a loaded review is read again", async () => {
			aPopulatedStore();
			const manager = createReviewComments("/repo", scheduler);
			await flush();
			holdActiveThreads();

			manager.refresh();
			await flush();

			expect(manager.shownReadState).toBe("ready");
			expect(manager.shownThreads.map((t) => t.id)).toEqual(["c1"]);
			manager.destroy();
		});

		it.each([
			["failed", "list_reviews"],
			["failed", "get_active_review"],
			["failed", "list_threads"],
			["failed", "list_session_commits"],
			["ready", "get_review_snapshots"],
		])("is %s when %s rejects", async (expected, cmd) => {
			failing(cmd);

			const manager = createReviewComments("/repo", scheduler);
			await flush();

			expect(manager.shownReadState).toBe(expected);
			manager.destroy();
		});

		it("keeps the active review's threads for its other readers when a read fails", async () => {
			failing("list_session_commits");

			const manager = createReviewComments("/repo", scheduler);
			await flush();

			expect(manager.threads.map((t) => t.id)).toEqual(["c1"]);
			manager.destroy();
		});

		it("draws none of the threads a failed read did get", async () => {
			failing("list_session_commits");

			const manager = createReviewComments("/repo", scheduler);
			await flush();

			expect(manager.shownThreads).toEqual([]);
			manager.destroy();
		});

		it("draws none of the commits a failed read did get", async () => {
			failing("list_threads");

			const manager = createReviewComments("/repo", scheduler);
			await flush();

			expect(manager.shownCommits).toEqual([]);
			manager.destroy();
		});

		it("is pending again while a failed read is retried", async () => {
			failing("list_threads");
			const manager = createReviewComments("/repo", scheduler);
			await flush();
			aPopulatedStore();
			holdActiveThreads();

			manager.refresh();
			await flush();

			expect(manager.shownReadState).toBe("pending");
			manager.destroy();
		});
	});

	it("clears a read failure once a refresh comes back clean", async () => {
		failing("list_threads");
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		expect(manager.lastError).not.toBeNull();

		aPopulatedStore();
		await manager.refresh();

		expect(manager.lastError).toBeNull();
		expect(manager.threadsAuthoritative).toBe(true);
		manager.destroy();
	});

	it("rejects a thread batch that belongs to another active review", async () => {
		aPopulatedStore({
			list_threads: [{ ...thread, review_id: "OTHER_REVIEW" }],
		});

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.threads).toHaveLength(0);
		expect(manager.threadsAuthoritative).toBe(false);
		manager.destroy();
	});
});

describe("createReviewComments — opening", () => {
	it("recomputes staleness after opening", async () => {
		aPopulatedStore({ refresh_thread_staleness: 0 });

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(mockInvoke).toHaveBeenCalledWith("refresh_thread_staleness", {
			path: "/repo",
		});
		manager.destroy();
	});
});

describe("createReviewComments — reviews-changed listener", () => {
	it("refreshes on an event for its own repo", async () => {
		aPopulatedStore();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const before = manager.revision;

		fireReviewsChanged("/repo");
		await flush();

		expect(manager.revision).toBeGreaterThan(before);
		manager.destroy();
	});

	it("refreshes on a payload-free event, the store poll's shape", async () => {
		// The poll can't know which repo a foreign commit touched, so it
		// announces with no payload and every tab refreshes its own.
		aPopulatedStore();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const before = manager.revision;

		fireReviewsChanged(null);
		await flush();

		expect(manager.revision).toBeGreaterThan(before);
		manager.destroy();
	});

	it("ignores an event for another repo", async () => {
		aPopulatedStore();
		const manager = createReviewComments("/repo", scheduler);
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
		overrideReads((c) => {
			if (c !== "canonical_repo_path") return undefined;

			attempts += 1;
			return attempts === 1
				? Promise.reject('{"code":"io","message":"transient"}')
				: Promise.resolve("/repo");
		});
		const manager = createReviewComments("/repo", scheduler);
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
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const before = manager.revision;

		fireReviewsChanged("/repo");
		await flush();

		expect(manager.revision).toBe(before);
		manager.destroy();
	});
});

describe("createReviewComments — repo-changed listener", () => {
	it("recomputes staleness when this repo's files change", async () => {
		aPopulatedStore({ refresh_thread_staleness: 0 });
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		mockInvoke.mockClear();

		fireRepoChanged("/repo");
		await flush();

		expect(mockInvoke).toHaveBeenCalledWith("refresh_thread_staleness", {
			path: "/repo",
		});
		manager.destroy();
	});

	it("ignores a change in another repo", async () => {
		aPopulatedStore({ refresh_thread_staleness: 0 });
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		mockInvoke.mockClear();

		fireRepoChanged("/somewhere-else");
		await flush();

		expect(mockInvoke).not.toHaveBeenCalledWith(
			"refresh_thread_staleness",
			expect.anything(),
		);
		manager.destroy();
	});
});

describe("createReviewComments - refresh backpressure", () => {
	it("coalesces review events caused by repeated staleness refreshes", async () => {
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
				case "refresh_thread_staleness":
					fireReviewsChanged("/repo");
					return Promise.resolve(0);
				default:
					return Promise.resolve([]);
			}
		});

		const manager = createReviewComments("/repo", scheduler);
		await flush();
		expect(gates).toHaveLength(1);

		for (let index = 0; index < 5; index += 1) {
			fireRepoChanged("/repo");
			await flush();
		}
		expect(gates).toHaveLength(1);

		gates[0]?.([]);
		await flush();
		await flush();
		expect(gates).toHaveLength(2);
		gates[1]?.([thread]);
		await flush();

		expect(manager.threads).toEqual([thread]);
		manager.destroy();
	});

	it("admits one later batch while a review read is active", async () => {
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

		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const later = manager.refresh();
		await Promise.resolve();
		expect(gates).toHaveLength(1);

		gates[0]?.([]);
		await flush();
		await flush();
		expect(gates).toHaveLength(2);

		gates[1]?.([thread]);
		await later;

		expect(manager.threads).toHaveLength(1);
		manager.destroy();
	});
});

describe("createReviewComments — the shown review", () => {
	const other: Review = {
		...review,
		id: "REVIEW02",
		title: "Second pass",
		thread_count: 1,
		unresolved_count: 1,
		pending_count: 0,
	};
	const otherThread = aThread({ id: "c2", review_id: "REVIEW02" });
	const otherCommits: SessionCommit[] = [
		aSessionCommit({ oid: "def", short_oid: "def", summary: "two" }),
	];

	/** Two reviews, REVIEW01 active; a read that names REVIEW02 answers for it. */
	function twoReviews() {
		aPopulatedStore({ list_reviews: [review, other] });
		overrideReads((cmd, reviewId) => {
			if (reviewId === "REVIEW02" && cmd === "list_threads")
				return Promise.resolve([otherThread]);
			if (reviewId === "REVIEW02" && cmd === "list_session_commits")
				return Promise.resolve(otherCommits);
			return undefined;
		});
	}

	it("follows the active review until another is selected", async () => {
		twoReviews();

		const manager = createReviewComments("/repo", scheduler);
		await flush();

		expect(manager.shownReviewId).toBe("REVIEW01");
		expect(manager.shownThreads.map((t) => t.id)).toEqual(["c1"]);
		manager.destroy();
	});

	it("reads a selected review's threads and commits without moving the active ones", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();

		manager.select("REVIEW02");
		await flush();

		expect(manager.shownReview?.title).toBe("Second pass");
		expect(manager.shownThreads.map((t) => t.id)).toEqual(["c2"]);
		expect(manager.shownCommits.map((c) => c.oid)).toEqual(["def"]);
		expect(manager.threads.map((t) => t.id)).toEqual(["c1"]);
		expect(manager.activeReviewId).toBe("REVIEW01");
		manager.destroy();
	});

	it("loads only the chosen review when switching from the active review", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		mockInvoke.mockClear();

		await manager.select(other.id);

		expect(manager.shownThreads.map((item) => item.id)).toEqual(["c2"]);
		expect(manager.shownCommits).toEqual(otherCommits);
		const args = { path: "/repo", reviewId: other.id };
		expect(mockInvoke).toHaveBeenCalledTimes(2);
		expect(mockInvoke).toHaveBeenCalledWith("list_threads", args);
		expect(mockInvoke).toHaveBeenCalledWith("list_session_commits", args);
		manager.destroy();
	});

	it("repairs an ambiguous active thread batch when returning from an archive", async () => {
		twoReviews();
		overrideReads((cmd, id) =>
			cmd === "list_threads" && id === undefined
				? Promise.resolve([])
				: undefined,
		);
		const manager = await aStoreShowing(other.id);
		expect(manager.threadsAuthoritative).toBe(false);
		twoReviews();

		await manager.select(review.id);

		expect(manager.shownThreads).toEqual([thread]);
		expect(manager.threadsAuthoritative).toBe(true);
		manager.destroy();
	});

	it("bounds a burst of archive reads and spends the next free slot on the latest choice", async () => {
		const archives = Array.from({ length: 8 }, (_, i) => ({
			...other,
			id: `archive-${i}`,
		}));
		aPopulatedStore({ list_reviews: [review, ...archives] });
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const held = new Map<string, PromiseWithResolvers<Thread[]>>();
		overrideReads((cmd, id) => {
			if (cmd !== "list_threads" || typeof id !== "string") return;
			const reply = Promise.withResolvers<Thread[]>();
			held.set(id, reply);
			return reply.promise;
		});

		const picks = archives.map((archive) => manager.select(archive.id));
		const latest = archives[archives.length - 1].id;
		const repeated = manager.select(latest);
		try {
			expect(manager.shownReviewId).toBe(latest);
			expect(Array.from(held.keys())).toEqual(["archive-0", "archive-1"]);
			held.get("archive-1")?.resolve([]);
			await flush();
			expect(Array.from(held.keys())).toEqual([
				"archive-0",
				"archive-1",
				latest,
			]);
			held.get(latest)?.resolve([aThread({ id: "latest", review_id: latest })]);
			await Promise.all([picks[picks.length - 1], repeated]);
			expect(manager.shownThreads.map((t) => t.id)).toEqual(["latest"]);
		} finally {
			manager.destroy();
			for (const reply of held.values()) reply.resolve([]);
			await Promise.all(picks);
		}
	});

	it("retains valid active contents when a superseded archive read fails", async () => {
		const third = { ...other, id: "third" };
		twoReviews();
		overrideReads((cmd) =>
			cmd === "list_reviews"
				? Promise.resolve([review, other, third])
				: undefined,
		);
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const list = Promise.withResolvers<Review[]>();
		const chosen = Promise.withResolvers<Thread[]>();
		overrideReads((cmd, id) => {
			if (cmd === "list_reviews") return list.promise;
			if (cmd === "get_active_review") return Promise.resolve(other.id);
			if (cmd === "list_threads" && id === other.id) return chosen.promise;
			if (cmd === "list_threads" && id === undefined)
				return Promise.resolve([otherThread]);
			if (cmd === "list_threads" && id === third.id)
				return Promise.resolve([aThread({ id: "c3", review_id: third.id })]);
		});
		const refresh = manager.refresh();
		await flush();
		const obsolete = manager.select(other.id);
		list.resolve([review, other, third]);
		await flush();
		await manager.select(third.id);
		chosen.reject(new Error("obsolete read failed"));
		await Promise.all([obsolete, refresh]);

		expect(manager.threads).toEqual([otherThread]);
		expect(manager.shownThreads.map((t) => t.id)).toEqual(["c3"]);
		expect(manager.lastError).toBeNull();
		manager.destroy();
	});

	it.each(["before", "after"])(
		"shows the newer explicit pick when an older listing fails %s its details arrive",
		async (order) => {
			twoReviews();
			const manager = createReviewComments("/repo", scheduler);
			await flush();
			const listing = Promise.withResolvers<Review[]>();
			const chosen = Promise.withResolvers<Thread[]>();
			overrideReads((cmd, id) => {
				if (cmd === "get_active_review") return Promise.resolve(other.id);
				if (cmd === "list_reviews") return listing.promise;
				if (cmd === "list_threads" && id === other.id) return chosen.promise;
			});
			const refresh = manager.refresh();
			await flush();
			const selection = manager.select(other.id);
			if (order === "before") {
				listing.reject(new Error("list unavailable"));
				await flush();
			}
			chosen.resolve([otherThread]);
			await selection;
			listing.reject(new Error("list unavailable"));
			await refresh;

			expect(manager.shownReadState).toBe("ready");
			expect(manager.shownThreads).toEqual([otherThread]);
			expect(manager.shownReview?.id).toBe(other.id);
			manager.destroy();
		},
	);
	it("opens a listed review while an unrelated active thread read is outstanding", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const activeThreads = Promise.withResolvers<Thread[]>();
		const entered = Promise.withResolvers<void>();
		overrideReads((cmd, id) => {
			if (cmd === "list_threads" && id === undefined) {
				entered.resolve();
				return activeThreads.promise;
			}
		});
		const refreshing = manager.refresh();
		await entered.promise;

		const picked = manager.select(other.id);
		await flush();
		try {
			expect(manager.shownReadState).toBe("ready");
			expect(manager.shownThreads.map((item) => item.id)).toEqual(["c2"]);
		} finally {
			activeThreads.resolve([thread]);
			await Promise.all([refreshing, picked]);
			manager.destroy();
		}
	});

	it.each(["before", "after"])(
		"keeps the fresh archive read when an older refresh makes it active %s the picked reply",
		async (order) => {
			twoReviews();
			const manager = createReviewComments("/repo", scheduler);
			await flush();
			const list = Promise.withResolvers<Review[]>();
			const chosenThreads = Promise.withResolvers<Thread[]>();
			overrideReads((cmd, id) => {
				if (cmd === "list_reviews") return list.promise;
				if (cmd === "get_active_review") return Promise.resolve(other.id);
				if (cmd === "list_threads")
					return id === other.id
						? chosenThreads.promise
						: Promise.resolve([{ ...otherThread, text: "old" }]);
				if (cmd === "list_session_commits" && !id)
					return Promise.resolve(commits);
			});
			const refresh = manager.refresh();
			await flush();
			const selection = manager.select(other.id);
			if (order === "before") {
				list.resolve([review, other]);
				await flush();
			}
			chosenThreads.resolve([{ ...otherThread, text: "fresh" }]);
			await selection;
			list.resolve([review, other]);
			await refresh;

			expect(manager.shownThreads.map((t) => t.text)).toEqual(["fresh"]);
			expect(manager.threads.map((t) => t.text)).toEqual(["fresh"]);
			expect(manager.activeReviewId).toBe(other.id);
			expect(manager.commits).toEqual(otherCommits);
			manager.destroy();
		},
	);

	it("keeps the last review list when a listing begun before selection fails", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const list = Promise.withResolvers<Review[]>();
		overrideReads((cmd) => (cmd === "list_reviews" ? list.promise : undefined));
		const refresh = manager.refresh();
		await flush();
		await manager.select(other.id);
		list.reject(new Error("busy"));
		await refresh;

		expect(manager.shownReview?.title).toBe(other.title);
		expect(manager.shownThreads).toEqual([otherThread]);
		expect(manager.shownReadState).toBe("ready");
		manager.destroy();
	});

	it("revalidates the last known review list before opening a pick after a failed listing", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		overrideReads((cmd) =>
			cmd === "list_reviews" ? Promise.reject(new Error("busy")) : undefined,
		);
		await manager.refresh();
		aPopulatedStore();

		await manager.select(other.id);

		expect(manager.shownReviewId).toBe(review.id);
		expect(manager.shownReadState).toBe("ready");
		expect(manager.reviews).toEqual([review]);
		manager.destroy();
	});

	it("recovers the active pointer and its store subscription on a pick after canonical lookup failed", async () => {
		twoReviews();
		overrideReads((cmd) =>
			cmd === "canonical_repo_path"
				? Promise.reject(new Error("busy"))
				: undefined,
		);
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		fireReviewsChanged("/repo");
		overrideReads((cmd) => {
			if (cmd === "canonical_repo_path") return Promise.resolve("/repo");
			if (cmd === "get_active_review") return Promise.resolve(other.id);
			if (cmd === "list_threads") return Promise.resolve([otherThread]);
		});

		await manager.select(other.id);
		expect(manager.activeReviewId).toBe(other.id);
		expect(manager.shownThreads).toEqual([otherThread]);
		const prior = manager.revision;
		fireReviewsChanged("/repo");
		await flush();
		expect(manager.revision).toBeGreaterThan(prior);
		manager.destroy();
	});

	it("revalidates the panel when the displayed archive is chosen again", async () => {
		twoReviews();
		const manager = await aStoreShowing(other.id);
		const prior = manager.revision;

		await manager.select(other.id);

		expect(manager.revision).toBeGreaterThan(prior);
		expect(manager.revisionScope).toBe("full");
		manager.destroy();
	});

	it("keeps the review picked while a refresh moves the active pointer elsewhere", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const nextActive = Promise.withResolvers<string>();
		overrideReads((cmd) =>
			cmd === "get_active_review" ? nextActive.promise : undefined,
		);
		const refreshing = manager.refresh();
		await flush();

		const picked = manager.select(review.id);
		nextActive.resolve(other.id);
		await Promise.all([refreshing, picked]);

		expect(manager.shownReviewId).toBe(review.id);
		expect(manager.shownReadState).toBe("ready");
		expect(manager.shownThreads.map((item) => item.id)).toEqual(["c1"]);
		manager.destroy();
	});

	it("ignores a superseded archive failure after leaving and returning to the same review", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const oldThreads = Promise.withResolvers<Thread[]>();
		let first = true;
		overrideReads((cmd, id) => {
			if (first && cmd === "list_threads" && id === other.id) {
				first = false;
				return oldThreads.promise;
			}
		});
		const firstPick = manager.select(other.id);
		await manager.select(review.id);
		await manager.select(other.id);
		oldThreads.reject(new Error("obsolete read"));
		await firstPick;

		expect(manager.shownThreads.map((item) => item.id)).toEqual(["c2"]);
		expect(manager.lastError).toBeNull();
		manager.destroy();
	});

	/**
	 * Holds every later read of REVIEW02's threads. Each settle answers the
	 * oldest read still held, so the test flushes until the store has asked.
	 */
	function holdOtherThreads() {
		const asked: PromiseWithResolvers<Thread[]>[] = [];
		overrideReads((cmd, reviewId) => {
			if (reviewId !== "REVIEW02" || cmd !== "list_threads") return undefined;

			const read = Promise.withResolvers<Thread[]>();
			asked.push(read);
			return read.promise;
		});
		function oldest() {
			const read = asked.shift();
			if (!read)
				throw new Error("the store has not asked for REVIEW02's threads");
			return read;
		}
		return {
			resolve(threads: Thread[]) {
				oldest().resolve(threads);
			},
			reject(reason: unknown) {
				oldest().reject(reason);
			},
		};
	}

	async function aStoreShowing(reviewId: string) {
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		await manager.select(reviewId);
		return manager;
	}

	describe("shownReadState", () => {
		it("is pending while a picked review's threads are read", async () => {
			twoReviews();
			const manager = createReviewComments("/repo", scheduler);
			await flush();
			holdOtherThreads();

			manager.select("REVIEW02");
			await flush();

			expect(manager.shownReadState).toBe("pending");
			manager.destroy();
		});

		it("is ready with the picked review's threads once they are read", async () => {
			twoReviews();
			const manager = createReviewComments("/repo", scheduler);
			await flush();
			const read = holdOtherThreads();

			const picked = manager.select("REVIEW02");
			await flush();
			read.resolve([otherThread]);
			await picked;

			expect(manager.shownReadState).toBe("ready");
			expect(manager.shownThreads.map((t) => t.id)).toEqual(["c2"]);
			manager.destroy();
		});

		it.each([
			["picked again", (m: ReviewCommentsManager) => m.select("REVIEW02")],
			["refreshed", (m: ReviewCommentsManager) => m.refresh()],
		])(
			"stays ready with the previous threads while a loaded pick is %s",
			async (_, reread) => {
				twoReviews();
				const manager = await aStoreShowing("REVIEW02");
				holdOtherThreads();

				reread(manager);
				await flush();

				expect(manager.shownReadState).toBe("ready");
				expect(manager.shownThreads.map((t) => t.id)).toEqual(["c2"]);
				manager.destroy();
			},
		);

		describe("when the read fails", () => {
			const lockedStore = '{"code":"store","message":"database is locked"}';

			function failOtherCommits() {
				overrideReads((cmd, reviewId) =>
					reviewId === "REVIEW02" && cmd === "list_session_commits"
						? Promise.reject(lockedStore)
						: undefined,
				);
			}

			it("is failed when the picked review's threads cannot be read", async () => {
				twoReviews();
				const manager = createReviewComments("/repo", scheduler);
				await flush();
				const read = holdOtherThreads();

				const picked = manager.select("REVIEW02");
				await flush();
				read.reject(lockedStore);
				await picked;

				expect(manager.shownReadState).toBe("failed");
				expect(manager.lastError).toBe("database is locked");
				manager.destroy();
			});

			it("is failed when only the picked review's commits cannot be read", async () => {
				twoReviews();
				failOtherCommits();

				const manager = await aStoreShowing("REVIEW02");

				expect(manager.shownReadState).toBe("failed");
				manager.destroy();
			});

			it("draws none of a failed pick's threads that did arrive", async () => {
				twoReviews();
				failOtherCommits();

				const manager = await aStoreShowing("REVIEW02");

				expect(manager.shownThreads).toEqual([]);
				manager.destroy();
			});

			it("is failed when a loaded pick's threads cannot be read again", async () => {
				twoReviews();
				const manager = await aStoreShowing("REVIEW02");
				const read = holdOtherThreads();

				const reread = manager.refresh();
				await flush();
				read.reject(lockedStore);
				await reread;

				expect(manager.shownReadState).toBe("failed");
				manager.destroy();
			});

			it("is failed when the review list cannot be read after a pick", async () => {
				twoReviews();
				const manager = await aStoreShowing("REVIEW02");
				overrideReads((cmd) =>
					cmd === "list_reviews" ? Promise.reject(lockedStore) : undefined,
				);

				await manager.refresh();

				expect(manager.shownReadState).toBe("failed");
				manager.destroy();
			});

			/** A store showing REVIEW02 after its threads failed to read, with the next read held. */
			async function aStoreAfterAFailedPick() {
				twoReviews();
				const manager = createReviewComments("/repo", scheduler);
				await flush();
				const read = holdOtherThreads();
				const picked = manager.select("REVIEW02");
				await flush();
				read.reject(lockedStore);
				await picked;
				return { manager, read };
			}

			it.each([
				["picked again", (m: ReviewCommentsManager) => m.select("REVIEW02")],
				["refreshed", (m: ReviewCommentsManager) => m.refresh()],
			])("is pending again while it is %s", async (_, reread) => {
				const { manager } = await aStoreAfterAFailedPick();

				reread(manager);
				await flush();

				expect(manager.lastError).toBe("database is locked");
				expect(manager.shownReadState).toBe("pending");
				manager.destroy();
			});

			it("is pending from the start of a retry, before the picked review is read", async () => {
				const { manager } = await aStoreAfterAFailedPick();
				overrideReads((cmd) =>
					cmd === "list_reviews" ? new Promise<Review[]>(() => {}) : undefined,
				);

				manager.refresh();
				await flush();

				expect(manager.shownReadState).toBe("pending");
				manager.destroy();
			});

			it.each([
				["picked again", (m: ReviewCommentsManager) => m.select("REVIEW02")],
				["refreshed", (m: ReviewCommentsManager) => m.refresh()],
			])("is ready with the threads once it is %s", async (_, reread) => {
				const { manager, read } = await aStoreAfterAFailedPick();

				const retried = reread(manager);
				await flush();
				read.resolve([otherThread]);
				await retried;

				expect(manager.shownReadState).toBe("ready");
				expect(manager.shownThreads.map((t) => t.id)).toEqual(["c2"]);
				manager.destroy();
			});
		});
	});

	describe("diffThreads", () => {
		const lockedStore = '{"code":"store","message":"database is locked"}';

		/** Fails the active review's read of cmd; a picked review's reads answer. */
		function failActiveRead(cmd: string) {
			overrideReads((c, reviewId) =>
				reviewId === undefined && c === cmd
					? Promise.reject(lockedStore)
					: undefined,
			);
		}

		it("are a picked review's threads once they are read", async () => {
			twoReviews();

			const manager = await aStoreShowing("REVIEW02");

			expect(manager.diffThreads.map((t) => t.id)).toEqual(["c2"]);
			manager.destroy();
		});

		it.each(["list_session_commits", "list_reviews"])(
			"keep the active review's threads when its %s read fails",
			async (cmd) => {
				twoReviews();
				const manager = createReviewComments("/repo", scheduler);
				await flush();
				failActiveRead(cmd);

				await manager.refresh();

				expect(manager.shownReadState).toBe("failed");
				expect(manager.diffThreads.map((t) => t.id)).toEqual(["c1"]);
				manager.destroy();
			},
		);

		it("are empty while a failed review list hides a pick", async () => {
			twoReviews();
			const manager = await aStoreShowing("REVIEW02");
			overrideReads((cmd) =>
				cmd === "list_reviews" ? Promise.reject(lockedStore) : undefined,
			);

			await manager.refresh();

			expect(manager.diffThreads).toEqual([]);
			manager.destroy();
		});

		it("are the active review's once a deleted pick falls back to it", async () => {
			twoReviews();
			const manager = await aStoreShowing("REVIEW02");

			aPopulatedStore();
			await manager.refresh();

			expect(manager.diffThreads.map((t) => t.id)).toEqual(["c1"]);
			manager.destroy();
		});

		it.each(["list_session_commits", "list_reviews"])(
			"keep the active review's threads when its %s read fails after a deleted pick",
			async (cmd) => {
				twoReviews();
				const manager = await aStoreShowing("REVIEW02");
				aPopulatedStore();
				await manager.refresh();
				failActiveRead(cmd);

				await manager.refresh();

				expect(manager.shownReadState).toBe("failed");
				expect(manager.diffThreads.map((t) => t.id)).toEqual(["c1"]);
				manager.destroy();
			},
		);

		it("keep the active review's threads when its commits read fails after it is picked back", async () => {
			twoReviews();
			const manager = await aStoreShowing("REVIEW02");
			await manager.select("REVIEW01");
			failActiveRead("list_session_commits");

			await manager.refresh();

			expect(manager.shownReadState).toBe("failed");
			expect(manager.diffThreads.map((t) => t.id)).toEqual(["c1"]);
			manager.destroy();
		});

		it.each([
			[
				"successful",
				() => {},
				(read: PromiseWithResolvers<Review[]>) => read.resolve([review]),
			],
			[
				"failed active commit read",
				() => failActiveRead("list_session_commits"),
				(read: PromiseWithResolvers<Review[]>) => read.resolve([review]),
			],
			[
				"failed review list",
				() => {},
				(read: PromiseWithResolvers<Review[]>) => read.reject(lockedStore),
			],
		])(
			"shows a newly made review as pending through an older %s",
			async (_, arrangeOlderRead, settleOlderList) => {
				aPopulatedStore();
				const manager = createReviewComments("/repo", scheduler);
				await flush();
				const olderList = Promise.withResolvers<Review[]>();
				arrangeOlderRead();
				overrideReads((cmd) =>
					cmd === "list_reviews" ? olderList.promise : undefined,
				);
				const reading = manager.refresh();
				await flush();

				// Creation makes REVIEW02 active before select() records the new pick.
				const newerList = Promise.withResolvers<Review[]>();
				aPopulatedStore({
					get_active_review: other.id,
					list_threads: [otherThread],
					list_session_commits: otherCommits,
				});
				overrideReads((cmd) =>
					cmd === "list_reviews" ? newerList.promise : undefined,
				);
				const picked = manager.select(other.id);

				expect(manager.shownReviewId).toBe(other.id);
				expect(manager.shownReadState).toBe("pending");
				expect(manager.diffThreads).toEqual([]);
				settleOlderList(olderList);
				await reading;

				expect(manager.shownReviewId).toBe(other.id);
				expect(manager.shownReview).toBeNull();
				expect(manager.shownReadState).toBe("pending");
				expect(manager.shownThreads).toEqual([]);
				expect(manager.diffThreads).toEqual([]);
				newerList.resolve([review, other]);
				await picked;

				expect(manager.shownReviewId).toBe(other.id);
				expect(manager.shownReadState).toBe("ready");
				expect(manager.diffThreads.map((t) => t.id)).toEqual(["c2"]);
				manager.destroy();
			},
		);
	});

	it("falls back to the active review when the selected one is gone", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		manager.select("REVIEW02");
		await flush();

		aPopulatedStore();
		await manager.refresh();

		expect(manager.shownReviewId).toBe("REVIEW01");
		expect(manager.shownThreads.map((t) => t.id)).toEqual(["c1"]);
		manager.destroy();
	});

	it("keeps a pick made while an older review list is still being read", async () => {
		twoReviews();
		const manager = createReviewComments("/repo", scheduler);
		await flush();
		const olderList = Promise.withResolvers<Review[]>();
		overrideReads((cmd) =>
			cmd === "list_reviews" ? olderList.promise : undefined,
		);
		const reading = manager.refresh();
		await flush();
		overrideReads((cmd) =>
			cmd === "list_reviews" ? Promise.resolve([review, other]) : undefined,
		);

		const picked = manager.select("REVIEW02");
		olderList.resolve([review]);
		await reading;
		await picked;

		expect(manager.shownReviewId).toBe("REVIEW02");
		manager.destroy();
	});

	it.each([
		["still contains", [review, other]],
		["omits", [review]],
	])(
		"keeps a newer pick when an older list %s the prior pick",
		async (_, olderReviews) => {
			twoReviews();
			const manager = await aStoreShowing(other.id);
			const olderList = Promise.withResolvers<Review[]>();
			overrideReads((cmd) =>
				cmd === "list_reviews" ? olderList.promise : undefined,
			);
			const reading = manager.refresh();
			await flush();

			const newest = { ...other, id: "REVIEW03", title: "Third pass" };
			const newestThread = aThread({ id: "c3", review_id: newest.id });
			const newerList = Promise.withResolvers<Review[]>();
			aPopulatedStore({
				get_active_review: newest.id,
				list_threads: [newestThread],
				list_session_commits: otherCommits,
			});
			overrideReads((cmd) =>
				cmd === "list_reviews" ? newerList.promise : undefined,
			);
			const picked = manager.select(newest.id);

			expect(manager.shownReviewId).toBe(newest.id);
			expect(manager.shownReadState).toBe("pending");
			olderList.resolve(olderReviews);
			await reading;

			expect(manager.shownReviewId).toBe(newest.id);
			expect(manager.shownReview).toBeNull();
			expect(manager.shownReadState).toBe("pending");
			expect(manager.shownThreads).toEqual([]);
			expect(manager.diffThreads).toEqual([]);
			newerList.resolve([review, other, newest]);
			await picked;

			expect(manager.shownReviewId).toBe(newest.id);
			expect(manager.shownReadState).toBe("ready");
			expect(manager.diffThreads.map((t) => t.id)).toEqual(["c3"]);
			manager.destroy();
		},
	);
});
