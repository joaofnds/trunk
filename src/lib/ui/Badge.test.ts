import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import Badge from "./Badge.svelte";

const sha = createRawSnippet(() => ({
	render: () => "<span>a3f9c21</span>",
}));

describe("Badge", () => {
	it("is a button that submits nothing", () => {
		render(Badge, { props: { children: sha } });

		expect(screen.getByRole("button", { name: "a3f9c21" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it("is a filled box of the smallest control height, set in the caption mono", () => {
		render(Badge, { props: { children: sha } });

		expect(screen.getByRole("button")).toHaveClass(
			"inline-flex",
			"items-center",
			"h-control-xs",
			"px-1",
			"rounded",
			"bg-surface-chip",
			"font-mono",
			"text-caption",
			"font-medium",
			"text-text",
		);
	});

	it("takes the accent under the pointer", () => {
		render(Badge, { props: { children: sha } });

		expect(screen.getByRole("button")).toHaveClass("hover:text-accent-strong");
	});

	it("reports a click to its caller", async () => {
		let clicks = 0;
		render(Badge, {
			props: {
				children: sha,
				onclick: () => {
					clicks += 1;
				},
			},
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toBe(1);
	});

	describe("as a label", () => {
		it("names an id without being a control", () => {
			render(Badge, {
				props: { variant: "label", title: "a3f9c21e", children: sha },
			});

			expect(screen.queryByRole("button")).toBeNull();
			expect(screen.getByTitle("a3f9c21e")).toHaveClass(
				"h-control-xs",
				"bg-surface-chip",
				"font-mono",
			);
		});
	});

	describe("when muted", () => {
		it("sets a count in the muted color at the regular weight", () => {
			render(Badge, {
				props: { variant: "label", tone: "muted", title: "3", children: sha },
			});

			const badge = screen.getByTitle("3");
			expect(badge).toHaveClass("font-regular", "text-text-muted");
			expect(badge).not.toHaveClass("font-medium", "text-text");
		});
	});
});
