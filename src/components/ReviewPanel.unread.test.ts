import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIntersectionObserver } from "../__tests__/helpers/fake-intersection-observer.js";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import {
	aReply,
	aStateChange,
	aThread,
} from "../__tests__/helpers/thread-fixture.js";
import { safeInvoke } from "../lib/invoke.js";
import { ALL_THREADS, THREAD_PRESETS } from "../lib/review-filter.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import type { Review, Thread, ThreadFilter } from "../lib/types.js";
import ReviewPanel from "./ReviewPanel.svelte";
import ThreadCard from "./ThreadCard.svelte";

import "../__tests__/helpers/tauri-mock";

vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return { ...actual, safeInvoke: vi.fn() };
});

vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));

const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SETTLED = THREAD_PRESETS[2].filter;

const review: Review = {
	id: "REVIEW01",
	title: "Review",
	state: "open",
	visible_to_agent: true,
	archived: false,
	thread_count: 1,
	unresolved_count: 1,
	pending_count: 0,
	created_at: 0,
};

const reviewComments = createFakeReviewComments();

/** A note on the commit that the agent answered without moving its state. */
function answered(id: string, seen = false): Thread {
	return aThread({
		id,
		text: `question ${id}`,
		commit_oid: COMMIT,
		replies: [
			aReply({
				id: `${id}-answer`,
				channel: "agent",
				text_html: `<p>answer on ${id}</p>`,
				created_at: 2_000,
				seen,
			}),
		],
	});
}

function seed(threads: Thread[]) {
	reviewComments.seed({
		commits: [aSessionCommit({ oid: COMMIT, short_oid: "aaaaaaa" })],
		threads,
		reviews: [review],
		activeReviewId: review.id,
	});
	reviewComments.refresh();
}

interface Showing {
	windowFocused?: boolean;
	keysActive?: boolean;
	shown?: boolean;
	threadFilter?: ThreadFilter;
}

function props(showing: Showing = {}) {
	return {
		repoPath: "/repo",
		session: createReviewSession(),
		reviewComments,
		onJump: vi.fn(),
		onJumpToCommit: vi.fn(),
		windowFocused: true,
		keysActive: true,
		shown: true,
		threadFilter: ALL_THREADS,
		...showing,
	};
}

async function mount(threads: Thread[], showing: Showing = {}) {
	seed(threads);
	const view = render(ReviewPanel, { props: props(showing) });
	await settle();
	return view;
}

async function settle() {
	await Promise.resolve();
	await tick();
}

function cardOf(id: string): HTMLElement {
	const card = document.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
	if (card === null) throw new Error(`no card for ${id}`);
	return card;
}

function replyOf(id: string): HTMLElement {
	const reply = screen.getByText(`answer on ${id}`).closest("li");
	if (reply === null) throw new Error(`no reply on ${id}`);
	return reply;
}

async function scrollIntoView(...elements: HTMLElement[]) {
	for (const element of elements) FakeIntersectionObserver.enter(element);
	await settle();
}

async function scrollOutOfView(...elements: HTMLElement[]) {
	for (const element of elements) FakeIntersectionObserver.leave(element);
	await settle();
}

function markedIds(): string[] {
	return vi
		.mocked(safeInvoke)
		.mock.calls.filter(([command]) => command === "mark_replies_seen")
		.flatMap(([, args]) => (args as { ids: string[] }).ids);
}

function markerOn(id: string): HTMLElement | null {
	return within(cardOf(id)).queryByText("Unread");
}

function headerCount(): string | null {
	return screen.queryByText(/unread thread/)?.textContent ?? null;
}

beforeEach(() => {
	vi.clearAllMocks();
	reviewComments.reset();
	vi.mocked(safeInvoke).mockImplementation((command: string) =>
		Promise.resolve(command === "resolve_threads" ? [] : undefined),
	);
});

describe("ReviewPanel", () => {
	describe("unread signal", () => {
		it("counts a thread whose agent reply is unseen in the header", async () => {
			await mount([answered("c1")]);

			expect(headerCount()).toBe("1 unread thread");
		});

		it("draws the unread marker on that thread's card", async () => {
			await mount([answered("c1")]);

			expect(markerOn("c1")).toBeInTheDocument();
		});

		it("counts a thread the filter hides until it is shown", async () => {
			await mount([answered("c1")], { threadFilter: SETTLED });

			expect(headerCount()).toBe("1 unread thread");
		});

		it("leaves the state tallies as a seen answer has them", async () => {
			const unseen = await mount([answered("c1")]);
			const unseenTallies = screen.getByRole("list", {
				name: "Show threads by state",
			}).textContent;
			unseen.unmount();

			await mount([answered("c1", true)]);

			expect(
				screen.getByRole("list", { name: "Show threads by state" }).textContent,
			).toBe(unseenTallies);
		});

		describe("when every agent reply is seen", () => {
			it("draws no header count", async () => {
				await mount([answered("c1", true)]);

				expect(headerCount()).toBeNull();
			});

			it("draws no marker", async () => {
				await mount([answered("c1", true)]);

				expect(markerOn("c1")).toBeNull();
			});
		});
	});

	describe("marking replies seen", () => {
		it("marks the unseen agent reply once it is in view", async () => {
			await mount([answered("c1")]);

			await scrollIntoView(cardOf("c1"), replyOf("c1"));

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("mark_replies_seen", {
				path: "/repo",
				ids: ["c1-answer"],
			});
		});

		it("marks nothing while only the card's header is in view", async () => {
			await mount([answered("c1")]);

			await scrollIntoView(cardOf("c1"));

			expect(markedIds()).toEqual([]);
		});

		it("asks once for a reply that leaves and comes back before the store answers", async () => {
			await mount([answered("c1")]);
			await scrollIntoView(cardOf("c1"), replyOf("c1"));
			await scrollOutOfView(replyOf("c1"));

			await scrollIntoView(replyOf("c1"));

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		it.each<[string, Showing]>([
			["the window has no focus", { windowFocused: false }],
			["another tab is in front", { keysActive: false }],
			["a diff covers the panel", { shown: false }],
			["the filter hides the thread", { threadFilter: SETTLED }],
		])("marks nothing while %s", async (_, showing) => {
			await mount([answered("c1")], showing);

			await scrollIntoView(cardOf("c1"), replyOf("c1"));

			expect(markedIds()).toEqual([]);
		});

		it("marks the reply in view once the window regains focus", async () => {
			const view = await mount([answered("c1")], { windowFocused: false });
			await scrollIntoView(cardOf("c1"), replyOf("c1"));

			await view.rerender(props({ windowFocused: true }));
			await settle();

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		it("marks a reply that arrives while its card is in view", async () => {
			await mount([{ ...answered("c1", true), replies: [] }]);
			await scrollIntoView(cardOf("c1"));

			seed([answered("c1")]);
			await settle();
			await scrollIntoView(replyOf("c1"));

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		describe("when its settled thread folds the card", () => {
			const settled = (): Thread => ({
				...answered("c1"),
				state: "done",
				allowed_transitions: ["open"],
			});

			it("marks nothing while the card stays folded", async () => {
				await mount([answered("c0", true), settled()]);

				await scrollIntoView(cardOf("c1"));

				expect(screen.queryByText("answer on c1")).toBeNull();
				expect(markedIds()).toEqual([]);
			});

			it("marks the reply once the card is unfolded into view", async () => {
				await mount([answered("c0", true), settled()]);
				await scrollIntoView(cardOf("c1"));
				await fireEvent.click(
					within(cardOf("c1")).getByRole("button", { name: "Expand thread" }),
				);
				await settle();

				await scrollIntoView(replyOf("c1"));

				expect(markedIds()).toEqual(["c1-answer"]);
			});
		});

		describe("when later entries fold the reply away", () => {
			const buried = (): Thread => ({
				...answered("c1"),
				history: [3_000, 3_001, 3_002, 3_003].map((created_at, at) =>
					aStateChange({
						state: at % 2 === 0 ? "addressed" : "open",
						created_at,
					}),
				),
			});

			it("marks nothing before the reply is expanded", async () => {
				await mount([buried()]);

				await scrollIntoView(cardOf("c1"));

				expect(screen.queryByText("answer on c1")).toBeNull();
				expect(markedIds()).toEqual([]);
			});

			it("marks the reply once it is expanded into view", async () => {
				await mount([buried()]);
				await scrollIntoView(cardOf("c1"));
				await fireEvent.click(
					screen.getByRole("button", { name: /Show \d+ more replies/ }),
				);
				await settle();

				await scrollIntoView(replyOf("c1"));

				expect(markedIds()).toEqual(["c1-answer"]);
			});
		});
	});

	describe("the marker after marking", () => {
		async function readWhileInView() {
			await mount([answered("c1")]);
			await scrollIntoView(cardOf("c1"), replyOf("c1"));
			seed([answered("c1", true)]);
			await settle();
		}

		it("stays drawn while the card stays in view", async () => {
			await readWhileInView();

			expect(markerOn("c1")).toBeInTheDocument();
		});

		it("drops the header count as soon as the store says the reply is seen", async () => {
			await readWhileInView();

			expect(headerCount()).toBeNull();
		});

		it("is gone the next time the card is shown", async () => {
			await readWhileInView();
			await scrollOutOfView(cardOf("c1"), replyOf("c1"));

			await scrollIntoView(cardOf("c1"));

			expect(markerOn("c1")).toBeNull();
		});

		it("comes back with the card while a reply is still unseen", async () => {
			await mount([answered("c1")]);
			await scrollIntoView(cardOf("c1"));
			await scrollOutOfView(cardOf("c1"));

			await scrollIntoView(cardOf("c1"));

			expect(markerOn("c1")).toBeInTheDocument();
		});
	});
});

describe("ThreadCard", () => {
	it("leaves an inline card's replies unwatched, since only the panel shows them", async () => {
		render(ThreadCard, {
			props: {
				thread: answered("c1"),
				repoPath: "/repo",
				onedit: vi.fn(),
				ondelete: vi.fn(),
				variant: "inline",
			},
		});
		await settle();

		expect(FakeIntersectionObserver.observes(replyOf("c1"))).toBe(false);
	});
});
