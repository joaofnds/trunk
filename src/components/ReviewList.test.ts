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
		title: "Review 2026-08-12",
		state: "settled",
		published: false,
		archived: false,
		thread_count: 0,
		unresolved_count: 0,
		pending_count: 0,
		created_at: 0,
		...overrides,
	};
}

const OPEN: Review = {
	id: "READYRV1",
	title: "Auth review",
	state: "open",
	published: true,
	archived: false,
	thread_count: 2,
	unresolved_count: 1,
	pending_count: 0,
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
	seedReviews([aReview(), OPEN], ACTIVE_REVIEW);
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

		const open = screen.getByRole("button", {
			name: `Show review ${OPEN.id}`,
		});
		expect(open).toHaveTextContent("Auth review");
		expect(open).toHaveTextContent(OPEN.id);
		expect(open).toHaveTextContent("Open");
		expect(
			screen.getByRole("button", { name: `Show review ${ACTIVE_REVIEW}` }),
		).toHaveTextContent("Settled");
	});

	it("shows an older default title without the id it repeated", async () => {
		seedReviews([aReview({ title: `Review 2026-08-12 · ${ACTIVE_REVIEW}` })]);
		await renderList();

		const row = screen.getByRole("button", {
			name: `Show review ${ACTIVE_REVIEW}`,
		});
		expect(within(row).getByText("2026-08-12").parentElement).toHaveTextContent(
			/^Review 2026-08-12$/,
		);
	});

	it("keeps a date in the title on one line", async () => {
		seedReviews([aReview()]);
		await renderList();

		expect(screen.getByText("2026-08-12")).toHaveClass("whitespace-nowrap");
	});

	it("keeps its row actions to their glyphs, leaving the title the width", async () => {
		seedReviews([aReview()]);
		await renderList();

		for (const name of [
			`Rename review ${ACTIVE_REVIEW}`,
			`Delete review ${ACTIVE_REVIEW}`,
		]) {
			expect(screen.getByRole("button", { name })).not.toHaveClass(
				"min-w-target",
			);
		}
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
			seedReviews([{ ...OPEN, unresolved_count }]);
			await renderList();

			const count = screen.getByTitle(`${unresolved_count} unresolved of 2`);
			expect(count).toHaveTextContent(new RegExp(`^${shown}$`));
		},
	);

	it("starts a new review from the list's header and shows it", async () => {
		seedReviews([aReview()]);
		await renderList();
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			Promise.resolve(cmd === "create_review" ? OPEN.id : undefined),
		);
		reviewComments.seed({ reviews: [aReview(), OPEN] });

		await fireEvent.click(screen.getByRole("button", { name: "New review" }));
		await flush();

		expect(callArgs("create_review")).toEqual({ path: "/repo", title: null });
		expect(reviewComments.shownReviewId).toBe(OPEN.id);
	});

	it("marks the shown review, and only it, as current", async () => {
		twoReviews();
		await renderList();

		expect(
			screen.getByRole("button", { name: `Show review ${ACTIVE_REVIEW}` }),
		).toHaveAttribute("aria-current", "true");
		expect(
			screen.getByRole("button", { name: `Show review ${OPEN.id}` }),
		).not.toHaveAttribute("aria-current");
	});

	it("pressing a row shows that review without making it active", async () => {
		twoReviews();
		await renderList();

		await fireEvent.click(
			screen.getByRole("button", { name: `Show review ${OPEN.id}` }),
		);
		await flush();

		expect(reviewComments.shownReviewId).toBe(OPEN.id);
		expect(
			screen.getByRole("button", { name: `Show review ${OPEN.id}` }),
		).toHaveAttribute("aria-current", "true");
		expect(calledCommands()).not.toContain("set_active_review");
	});

	it("the radio makes a review the active one", async () => {
		twoReviews();
		await renderList();

		const radio = screen.getByRole("button", {
			name: `Active review ${OPEN.id}`,
		});
		expect(radio).toHaveAttribute("aria-pressed", "false");
		expect(radio).toHaveAttribute("title", "Make active");
		await fireEvent.click(radio);
		await flush();

		expect(callArgs("set_active_review")).toEqual({
			path: "/repo",
			reviewId: OPEN.id,
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

	describe("archiving a review", () => {
		const ARCHIVED: Review = { ...OPEN, archived: true };

		it("folds archived reviews under their own heading, out of the count", async () => {
			seedReviews([aReview(), ARCHIVED]);
			await renderList();

			expect(
				screen.getByRole("heading", { name: "Reviews 1" }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: `Show review ${OPEN.id}` }),
			).toBeNull();
			expect(
				screen.getByRole("button", { name: "Archived 1" }),
			).toHaveAttribute("aria-expanded", "false");
		});

		it("opens the archived reviews to show one", async () => {
			seedReviews([aReview(), ARCHIVED]);
			await renderList();

			await fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));

			expect(
				screen.getByRole("button", { name: `Show review ${OPEN.id}` }),
			).toBeInTheDocument();
		});

		it("offers no way to make an archived review active", async () => {
			seedReviews([aReview(), ARCHIVED]);
			await renderList();

			await fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));

			expect(
				screen.queryByRole("button", { name: `Active review ${OPEN.id}` }),
			).toBeNull();
			expect(
				screen.getByTitle("Archived: unarchive to make it active"),
			).toBeInTheDocument();
		});

		it("offers no heading when nothing is archived", async () => {
			twoReviews();
			await renderList();

			expect(screen.queryByRole("button", { name: /^Archived/ })).toBeNull();
		});
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
			const confirm = await askToDelete(OPEN);

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
			const confirm = await askToDelete(OPEN);

			await fireEvent.click(
				within(confirm).getByRole("button", { name: "Delete review" }),
			);
			await flush();

			expect(callArgs("delete_review")).toEqual({
				path: "/repo",
				reviewId: OPEN.id,
			});
		});

		it("keeps the review on Cancel", async () => {
			const confirm = await askToDelete(OPEN);

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

	it("puts the focus in the title editor with the title selected, ready to type over", async () => {
		seedReviews([aReview()]);
		await renderList();

		await fireEvent.click(
			screen.getByRole("button", { name: `Rename review ${ACTIVE_REVIEW}` }),
		);
		await tick();

		const field = screen.getByLabelText("Review title") as HTMLInputElement;
		expect(field).toHaveFocus();
		expect([field.selectionStart, field.selectionEnd]).toEqual([
			0,
			field.value.length,
		]);
	});

	it("opens the title editor as a plain standard field, since the caret shows where typing goes", async () => {
		seedReviews([aReview()]);
		await renderList();

		await fireEvent.click(
			screen.getByRole("button", { name: `Rename review ${ACTIVE_REVIEW}` }),
		);
		await tick();

		const field = screen.getByLabelText("Review title");
		expect(field).toHaveClass("border-border", "outline-none", "h-control");
		expect(field).not.toHaveClass("border-accent");
	});

	it("opens the title editor on the title as shown", async () => {
		seedReviews([aReview({ title: `Review 2026-08-12 · ${ACTIVE_REVIEW}` })]);
		await renderList();

		await fireEvent.click(
			screen.getByRole("button", { name: `Rename review ${ACTIVE_REVIEW}` }),
		);
		await tick();

		expect(screen.getByLabelText("Review title")).toHaveValue(
			"Review 2026-08-12",
		);
	});
});
