import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CommentBadge from "./CommentBadge.svelte";

describe("CommentBadge", () => {
	it("is an image named by its count for assistive tech", () => {
		render(CommentBadge, { props: { count: 3 } });
		expect(
			screen.getByRole("img", { name: "3 review comments" }),
		).toBeInTheDocument();
	});

	it("renders the count when positive", () => {
		render(CommentBadge, { props: { count: 3 } });
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("draws a message glyph beside the count", () => {
		render(CommentBadge, { props: { count: 3 } });

		const badge = screen.getByRole("img", { name: "3 review comments" });

		expect(badge.querySelector("svg")).not.toBeNull();
		expect(badge).toHaveTextContent("3");
	});

	it("renders nothing when count is zero", () => {
		const { container } = render(CommentBadge, { props: { count: 0 } });
		expect(container.textContent).toBe("");
	});

	it("renders nothing for a negative count", () => {
		const { container } = render(CommentBadge, { props: { count: -1 } });
		expect(container.textContent).toBe("");
	});

	it("gives a singular accessible name for one comment", () => {
		render(CommentBadge, { props: { count: 1 } });
		expect(screen.getByLabelText("1 review comment")).toBeInTheDocument();
	});

	it("gives a plural accessible name for many comments", () => {
		render(CommentBadge, { props: { count: 5 } });
		expect(screen.getByLabelText("5 review comments")).toBeInTheDocument();
	});

	it("does not infer the population from the dominant tone", () => {
		const { container } = render(CommentBadge, {
			props: { count: 2, tone: "done" },
		});

		const badge = screen.getByLabelText("2 review comments");
		expect(badge).toBeInTheDocument();
		expect(container.querySelector(".comment-badge-pill")).toHaveClass(
			"tone-done",
		);
	});

	it("splits the count into a pill per state it holds, most urgent first", () => {
		const { container } = render(CommentBadge, {
			props: { count: 3, tally: { addressed: 1, open: 2 } },
		});

		const pills = [...container.querySelectorAll(".comment-badge-pill")];

		expect(pills.map((pill) => pill.textContent?.trim())).toEqual(["2", "1"]);
		expect(pills[0]).toHaveClass("tone-open");
		expect(pills[1]).toHaveClass("tone-addressed");
	});

	it("names each state's share when it splits", () => {
		render(CommentBadge, {
			props: { count: 3, tally: { open: 2, addressed: 1 } },
		});

		expect(
			screen.getByRole("img", {
				name: "3 review comments, 2 open and 1 addressed",
			}),
		).toBeInTheDocument();
	});

	it("draws the message glyph once, on the first pill", () => {
		const { container } = render(CommentBadge, {
			props: { count: 3, tally: { open: 2, addressed: 1 } },
		});

		const pills = container.querySelectorAll(".comment-badge-pill");

		expect(pills[0].querySelector("svg")).not.toBeNull();
		expect(pills[1].querySelector("svg")).toBeNull();
	});
});
