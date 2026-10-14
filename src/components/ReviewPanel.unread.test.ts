import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FakeIntersectionObserver } from "../__tests__/helpers/fake-intersection-observer.js";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import ReviewVisibilityHost from "../__tests__/helpers/review-visibility-host.svelte";
import { aSessionCommit } from "../__tests__/helpers/session-commit-fixture.js";
import {
	aReply,
	aStateChange,
	aThread,
} from "../__tests__/helpers/thread-fixture.js";
import { BAR_HEIGHT } from "../lib/chrome-heights.js";
import { safeInvoke } from "../lib/invoke.js";
import { ALL_THREADS, THREAD_PRESETS } from "../lib/review-filter.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import { ReviewVisibility } from "../lib/review-visibility.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type { Review, Thread, ThreadFilter } from "../lib/types.js";
import ReviewPanel from "./ReviewPanel.svelte";

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

/** A thread on a file of the commit that the agent answered, unseen. */
function answeredOnFile(id: string): Thread {
	return {
		...answered(id),
		commit_oid: null,
		anchor: {
			commit_oid: COMMIT,
			file_path: "src/main.ts",
			source: "Diff",
			side: "New",
			start_line: 10,
			end_line: 12,
		},
	};
}

/** A thread the agent answered twice, each answer seen or not. */
function answeredTwice(id: string, seen: [boolean, boolean]): Thread {
	return aThread({
		id,
		text: `question ${id}`,
		commit_oid: COMMIT,
		replies: [
			aReply({
				id: `${id}-first`,
				channel: "agent",
				text_html: `<p>first answer on ${id}</p>`,
				created_at: 2_000,
				seen: seen[0],
			}),
			aReply({
				id: `${id}-second`,
				channel: "agent",
				text_html: `<p>second answer on ${id}</p>`,
				created_at: 4_000,
				seen: seen[1],
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
	return replyReading(`answer on ${id}`);
}

function replyReading(text: string): HTMLElement {
	const reply = screen.getByText(text).closest("li");
	if (reply === null) throw new Error(`no reply reading ${text}`);
	return reply;
}

async function reportInView(...elements: HTMLElement[]) {
	for (const element of elements) FakeIntersectionObserver.enter(element);
	await settle();
}

async function reportOutOfView(...elements: HTMLElement[]) {
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

		it("counts a thread the filter hides", async () => {
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

		describe("when a later agent reply is seen and an earlier one is not", () => {
			it("still counts the thread in the header", async () => {
				await mount([answeredTwice("c1", [false, true])]);

				expect(headerCount()).toBe("1 unread thread");
			});

			it("still draws the marker", async () => {
				await mount([answeredTwice("c1", [false, true])]);

				expect(markerOn("c1")).toBeInTheDocument();
			});
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

			await reportInView(cardOf("c1"), replyOf("c1"));

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("mark_replies_seen", {
				path: "/repo",
				ids: ["c1-answer"],
			});
		});

		it("marks nothing while only the card's header is in view", async () => {
			await mount([answered("c1")]);

			await reportInView(cardOf("c1"));

			expect(markedIds()).toEqual([]);
		});

		it("asks once for a reply that leaves and comes back before the store answers", async () => {
			await mount([answered("c1")]);
			await reportInView(cardOf("c1"), replyOf("c1"));
			await reportOutOfView(replyOf("c1"));

			await reportInView(replyOf("c1"));

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		it.each<[string, Showing]>([
			["the window has no focus", { windowFocused: false }],
			["another tab is in front", { keysActive: false }],
			["a diff covers the panel", { shown: false }],
			["the filter hides the thread", { threadFilter: SETTLED }],
		])("marks nothing while %s", async (_, showing) => {
			await mount([answered("c1")], showing);

			await reportInView(cardOf("c1"), replyOf("c1"));

			expect(markedIds()).toEqual([]);
		});

		it.each<[string, Showing]>([
			["the window regains focus", { windowFocused: false }],
			["its tab comes to the front", { keysActive: false }],
			["the diff over the panel closes", { shown: false }],
		])("marks the reply in view once %s", async (_, hidden) => {
			const view = await mount([answered("c1")], hidden);
			await reportInView(cardOf("c1"), replyOf("c1"));

			await view.rerender(props());
			await settle();

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		it("marks every unseen agent reply of a thread in view", async () => {
			await mount([answeredTwice("c1", [false, false])]);

			await reportInView(
				cardOf("c1"),
				replyReading("first answer on c1"),
				replyReading("second answer on c1"),
			);

			expect(markedIds()).toEqual(["c1-first", "c1-second"]);
		});

		it("marks nothing in a commit folded under its bar", async () => {
			await mount([answered("c1")]);
			await fireEvent.click(
				screen.getByRole("button", { name: "Collapse commit" }),
			);
			await settle();

			await reportInView(cardOf("c1"), replyOf("c1"));

			expect(markedIds()).toEqual([]);
		});

		it("marks a reply that arrives while its card is in view", async () => {
			await mount([{ ...answered("c1", true), replies: [] }]);
			await reportInView(cardOf("c1"));

			seed([answered("c1")]);
			await settle();
			await reportInView(replyOf("c1"));

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		it("marks nothing for a reply that only touches the body's edge", async () => {
			await mount([answered("c1")]);
			await reportInView(cardOf("c1"));

			FakeIntersectionObserver.touch(replyOf("c1"));
			await settle();

			expect(markedIds()).toEqual([]);
		});

		it("marks a tall reply once its first pixel scrolls past the body's edge", async () => {
			await mount([answered("c1")]);
			await reportInView(cardOf("c1"));
			FakeIntersectionObserver.touch(replyOf("c1"));
			await settle();

			// One pixel of a 4000px reply in view.
			FakeIntersectionObserver.reveal(replyOf("c1"), 1 / 4000);
			await settle();

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		it("keeps watching the same reply element through a refresh", async () => {
			const view = await mount([answered("c1")], { windowFocused: false });
			await reportInView(cardOf("c1"), replyOf("c1"));
			seed([answered("c1")]);
			await settle();

			await view.rerender({ windowFocused: true });
			await settle();

			expect(markedIds()).toEqual(["c1-answer"]);
		});

		describe("under the sticky bars", () => {
			it("marks a whole-commit note's reply once it clears the branch and commit bars", async () => {
				await mount([answered("n1")]);
				await reportInView(cardOf("n1"));

				FakeIntersectionObserver.span(replyOf("n1"), {
					top: 0,
					bottom: 2 * BAR_HEIGHT + 1,
				});
				await settle();

				expect(markedIds()).toEqual(["n1-answer"]);
			});

			it("leaves a file thread's reply unread at a height that shows a note's", async () => {
				await mount([answered("n1"), answeredOnFile("f1")]);
				await reportInView(cardOf("n1"), cardOf("f1"));

				for (const reply of [replyOf("n1"), replyOf("f1")])
					FakeIntersectionObserver.span(reply, {
						top: 0,
						bottom: 2 * BAR_HEIGHT + 1,
					});
				await settle();

				expect(markedIds()).toEqual(["n1-answer"]);
			});

			it("marks a file thread's reply once it clears the file bar", async () => {
				await mount([answeredOnFile("f1")]);
				await reportInView(cardOf("f1"));

				FakeIntersectionObserver.span(replyOf("f1"), {
					top: 0,
					bottom: 3 * BAR_HEIGHT + 1,
				});
				await settle();

				expect(markedIds()).toEqual(["f1-answer"]);
			});
		});

		describe("when the store refuses the mark", () => {
			beforeEach(() => {
				let refused = false;
				vi.mocked(safeInvoke).mockImplementation((command: string) => {
					if (command !== "mark_replies_seen" || refused)
						return Promise.resolve(
							command === "resolve_threads" ? [] : undefined,
						);
					refused = true;
					return Promise.reject(new Error("store is busy"));
				});
			});

			it("tells the user why the store refused", async () => {
				await mount([answered("c1")]);

				await reportInView(cardOf("c1"), replyOf("c1"));

				expect(vi.mocked(showToast)).toHaveBeenCalledWith(
					"store is busy",
					"error",
				);
			});

			it("asks again once the reply comes back into view", async () => {
				await mount([answered("c1")]);
				await reportInView(cardOf("c1"), replyOf("c1"));
				await reportOutOfView(replyOf("c1"));

				await reportInView(replyOf("c1"));

				expect(markedIds()).toEqual(["c1-answer", "c1-answer"]);
			});
		});

		describe("when the store keeps refusing the mark", () => {
			beforeEach(() => {
				vi.mocked(safeInvoke).mockImplementation((command: string) =>
					command === "mark_replies_seen"
						? Promise.reject(new Error("store is read-only"))
						: Promise.resolve(command === "resolve_threads" ? [] : undefined),
				);
			});

			it("tells the user once however often it asks again", async () => {
				await mount([answered("c1")]);
				await reportInView(cardOf("c1"), replyOf("c1"));
				await reportOutOfView(replyOf("c1"));

				await reportInView(replyOf("c1"));

				expect(markedIds()).toEqual(["c1-answer", "c1-answer"]);
				expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
			});

			it("tells the user again when it refuses after a mark went through", async () => {
				const answers = [false, true, false];
				vi.mocked(safeInvoke).mockImplementation((command: string) => {
					if (command !== "mark_replies_seen")
						return Promise.resolve(
							command === "resolve_threads" ? [] : undefined,
						);
					return answers.shift()
						? Promise.resolve(undefined)
						: Promise.reject(new Error("store is read-only"));
				});
				await mount([answered("c1"), answered("c2"), answered("c3")]);
				await reportInView(cardOf("c1"), replyOf("c1"));
				await reportInView(cardOf("c2"), replyOf("c2"));

				await reportInView(cardOf("c3"), replyOf("c3"));

				expect(vi.mocked(showToast)).toHaveBeenCalledTimes(2);
			});
		});

		describe("when its settled thread folds the card", () => {
			const settled = (): Thread => ({
				...answered("c1"),
				state: "done",
				allowed_transitions: ["open"],
			});

			it("marks nothing while the card stays folded", async () => {
				await mount([answered("c0", true), settled()]);

				await reportInView(cardOf("c1"));

				expect(screen.queryByText("answer on c1")).toBeNull();
				expect(markedIds()).toEqual([]);
			});

			it("marks the reply once the card is unfolded into view", async () => {
				await mount([answered("c0", true), settled()]);
				await reportInView(cardOf("c1"));
				await fireEvent.click(
					within(cardOf("c1")).getByRole("button", { name: "Expand thread" }),
				);
				await settle();

				await reportInView(replyOf("c1"));

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

				await reportInView(cardOf("c1"));

				expect(screen.queryByText("answer on c1")).toBeNull();
				expect(markedIds()).toEqual([]);
			});

			it("marks the reply once it is expanded into view", async () => {
				await mount([buried()]);
				await reportInView(cardOf("c1"));
				await fireEvent.click(
					screen.getByRole("button", { name: /Show \d+ more replies/ }),
				);
				await settle();

				await reportInView(replyOf("c1"));

				expect(markedIds()).toEqual(["c1-answer"]);
			});
		});
	});

	describe("the marker after marking", () => {
		async function readWhileInView() {
			const view = await mount([answered("c1")]);
			await reportInView(cardOf("c1"), replyOf("c1"));
			seed([answered("c1", true)]);
			await settle();
			return view;
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
			await reportOutOfView(cardOf("c1"), replyOf("c1"));

			await reportInView(cardOf("c1"));

			expect(markerOn("c1")).toBeNull();
		});

		it.each<[string, Showing]>([
			["the window loses focus", { windowFocused: false }],
			["another tab comes to the front", { keysActive: false }],
			["a diff covers the panel", { shown: false }],
		])("is gone once %s and the card is shown again", async (_, hidden) => {
			const view = await readWhileInView();
			await view.rerender(props(hidden));
			await settle();

			await view.rerender(props());
			await settle();

			expect(markerOn("c1")).toBeNull();
		});

		it("is gone once the card folds", async () => {
			await readWhileInView();

			await fireEvent.click(
				within(cardOf("c1")).getByRole("button", { name: "Collapse thread" }),
			);
			await settle();

			expect(markerOn("c1")).toBeNull();
		});
	});
});

describe("ThreadCard", () => {
	async function drawUnderPanelContext(variant: "panel" | "inline") {
		const visibility = new ReviewVisibility();
		onTestFinished(visibility.connect(document.body, () => 0));
		render(ReviewVisibilityHost, {
			props: { visibility, thread: answered("c1"), variant },
		});
		await settle();
	}

	it("watches a panel card's unseen reply", async () => {
		await drawUnderPanelContext("panel");

		expect(FakeIntersectionObserver.observes(replyOf("c1"))).toBe(true);
	});

	it("leaves an inline card's replies unwatched, since only the panel shows them", async () => {
		await drawUnderPanelContext("inline");

		expect(FakeIntersectionObserver.observes(replyOf("c1"))).toBe(false);
	});
});
