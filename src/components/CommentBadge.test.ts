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
		expect(container.querySelector(".comment-badge")).toHaveClass("tone-done");
	});
});
