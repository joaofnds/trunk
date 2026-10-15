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
