import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { safeInvoke } from "../lib/invoke.js";
import type { Review } from "../lib/types.js";
import ReviewList from "./ReviewList.svelte";

import "../__tests__/helpers/tauri-mock";

vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return { ...actual, safeInvoke: vi.fn() };
});

vi.mock("../lib/toast.svelte.js", () => ({
	showToast: vi.fn(),
}));

const ACTIVE_REVIEW = "REVIEW01";

function aReview(overrides: Partial<Review> = {}): Review {
	return {
		id: ACTIVE_REVIEW,
		title: "Review 2026-08-12 · REVIEW01",
		state: "composing",
		published: false,
		thread_count: 0,
		unresolved_count: 0,
		created_at: 0,
		...overrides,
	};
}

const READY: Review = {
	id: "READYRV1",
	title: "Auth review",
	state: "ready",
	published: true,
	thread_count: 2,
	unresolved_count: 1,
	created_at: 0,
};

const reviewComments = createFakeReviewComments();

function seedReviews(
	reviews: Review[],
	activeReviewId: string = reviews[0].id,
) {
	reviewComments.seed({ reviews, activeReviewId });
	reviewComments.refresh();
}

function twoReviews() {
	seedReviews([aReview(), READY], ACTIVE_REVIEW);
}

async function renderList() {
	const view = render(ReviewList, {
		props: { repoPath: "/repo", reviewComments },
	});
	await flush();
	return view;
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await tick();
}

function calledCommands(): string[] {
	return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
}

function callArgs(cmd: string): Record<string, unknown> | undefined {
	const call = vi.mocked(safeInvoke).mock.calls.find((c) => c[0] === cmd);
	return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
	reviewComments.reset();
	vi.mocked(safeInvoke).mockReset();
	vi.mocked(safeInvoke).mockResolvedValue(undefined);
});

describe("ReviewList", () => {
	it("lists reviews with their derived state, short id and title", async () => {
		twoReviews();
		await renderList();

		const ready = screen.getByRole("button", {
			name: `Show review ${READY.id}`,
		});
		expect(ready).toHaveTextContent("Auth review");
		expect(ready).toHaveTextContent(READY.id);
		expect(ready).toHaveTextContent("Ready");
		expect(
			screen.getByRole("button", { name: `Show review ${ACTIVE_REVIEW}` }),
		).toHaveTextContent("Composing");
	});

	it("heads the list with the number of reviews", async () => {
		twoReviews();
		await renderList();

		expect(
			screen.getByRole("heading", { name: "Reviews 2" }),
		).toBeInTheDocument();
	});

	it.each([
		[1, "1/2"],
		[0, "2"],
	])(
		"counts %i unresolved of two threads as %s",
		async (unresolved_count, shown) => {
			seedReviews([{ ...READY, unresolved_count }]);
			await renderList();

			const count = screen.getByTitle(`${unresolved_count} unresolved of 2`);
			expect(count).toHaveTextContent(new RegExp(`^${shown}$`));
		},
	);

	it("starts a new review from the list's header and shows it", async () => {
		seedReviews([aReview()]);
		await renderList();
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			Promise.resolve(cmd === "create_review" ? READY.id : undefined),
		);
		reviewComments.seed({ reviews: [aReview(), READY] });

		await fireEvent.click(screen.getByRole("button", { name: "New review" }));
		await flush();

		expect(callArgs("create_review")).toEqual({ path: "/repo", title: null });
		expect(reviewComments.shownReviewId).toBe(READY.id);
	});

	it("marks the shown review, and only it, as current", async () => {
		twoReviews();
		await renderList();

		expect(
			screen.getByRole("button", { name: `Show review ${ACTIVE_REVIEW}` }),
		).toHaveAttribute("aria-current", "true");
		expect(
			screen.getByRole("button", { name: `Show review ${READY.id}` }),
		).not.toHaveAttribute("aria-current");
	});

	it("pressing a row shows that review without making it active", async () => {
		twoReviews();
		await renderList();

		await fireEvent.click(
			screen.getByRole("button", { name: `Show review ${READY.id}` }),
		);
		await flush();

		expect(reviewComments.shownReviewId).toBe(READY.id);
		expect(
			screen.getByRole("button", { name: `Show review ${READY.id}` }),
		).toHaveAttribute("aria-current", "true");
		expect(calledCommands()).not.toContain("set_active_review");
	});

	it("the radio makes a review the active one", async () => {
		twoReviews();
		await renderList();

		const radio = screen.getByRole("button", {
			name: `Active review ${READY.id}`,
		});
		expect(radio).toHaveAttribute("aria-pressed", "false");
		expect(radio).toHaveAttribute("title", "Make active");
		await fireEvent.click(radio);
		await flush();

		expect(callArgs("set_active_review")).toEqual({
			path: "/repo",
			reviewId: READY.id,
		});
	});

	it("does not re-activate the review that is already active", async () => {
		seedReviews([aReview()]);
		await renderList();

		const radio = screen.getByRole("button", {
			name: `Active review ${ACTIVE_REVIEW}`,
		});
		expect(radio).toHaveAttribute("aria-pressed", "true");
		expect(radio).toHaveAttribute("title", "Active: new comments land here");
		await fireEvent.click(radio);
		await flush();

		expect(calledCommands()).not.toContain("set_active_review");
	});

	it("says where new comments land under the list", async () => {
		seedReviews([aReview()]);
		await renderList();

		expect(
			screen.getByText("Active review. New comments land here."),
		).toBeInTheDocument();
	});

	describe("deleting a review", () => {
		async function askToDelete(review: Review) {
			seedReviews([review]);
			await renderList();
			await fireEvent.click(
				screen.getByRole("button", { name: `Delete review ${review.id}` }),
			);
			await flush();
			return screen.getByRole("group", { name: `Delete ${review.title}?` });
		}

		it("asks inline before deleting, naming what goes with it", async () => {
			const confirm = await askToDelete(READY);

			expect(confirm).toHaveTextContent(
				"Delete Auth review and its 2 threads? The agent loses access to it. This can’t be undone.",
			);
			expect(calledCommands()).not.toContain("delete_review");
		});

		it("says nothing of the agent for a review it never saw", async () => {
			const confirm = await askToDelete(aReview({ thread_count: 1 }));

			expect(confirm).toHaveTextContent(
				`Delete ${aReview().title} and its 1 thread? This can’t be undone.`,
			);
		});

		it("puts the question mark right after the title of a review with no threads", async () => {
			const confirm = await askToDelete(aReview({ thread_count: 0 }));

			expect(confirm).toHaveTextContent(
				`Delete ${aReview().title}? This can’t be undone.`,
			);
		});

		it("deletes the review once confirmed", async () => {
			const confirm = await askToDelete(READY);

			await fireEvent.click(
				within(confirm).getByRole("button", { name: "Delete review" }),
			);
			await flush();

			expect(callArgs("delete_review")).toEqual({
				path: "/repo",
				reviewId: READY.id,
			});
		});

		it("keeps the review on Cancel", async () => {
			const confirm = await askToDelete(READY);

			await fireEvent.click(
				within(confirm).getByRole("button", { name: "Cancel" }),
			);
			await flush();

			expect(screen.queryByRole("group", { name: /^Delete / })).toBeNull();
			expect(calledCommands()).not.toContain("delete_review");
		});
	});

	it("renames a review through the inline title editor", async () => {
		seedReviews([aReview()]);
		await renderList();

		await fireEvent.dblClick(
			screen.getByRole("button", { name: `Show review ${ACTIVE_REVIEW}` }),
		);
		await tick();
		const input = screen.getByLabelText("Review title") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Renamed" } });
		await fireEvent.blur(input);
		await flush();

		expect(callArgs("rename_review")).toEqual({
			path: "/repo",
			reviewId: ACTIVE_REVIEW,
			title: "Renamed",
		});
	});

	it("keeps the title when the edit is left blank", async () => {
		seedReviews([aReview()]);
		await renderList();

		await fireEvent.dblClick(
			screen.getByRole("button", { name: `Show review ${ACTIVE_REVIEW}` }),
		);
		await tick();
		const input = screen.getByLabelText("Review title") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "   " } });
		await fireEvent.blur(input);
		await flush();

		expect(calledCommands()).not.toContain("rename_review");
	});

	it("opens the title editor from the row's rename action", async () => {
		seedReviews([aReview()]);
		await renderList();

		await fireEvent.click(
			screen.getByRole("button", { name: `Rename review ${ACTIVE_REVIEW}` }),
		);
		await tick();

		expect(screen.getByLabelText("Review title")).toHaveValue(aReview().title);
	});
});
