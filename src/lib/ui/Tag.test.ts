import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import Tag from "./Tag.svelte";

const lines = createRawSnippet(() => ({
	render: () => "<span>Lines 10–11</span>",
}));

describe("Tag", () => {
	it("is a button that submits nothing", () => {
		render(Tag, { props: { children: lines } });

		expect(screen.getByRole("button", { name: "Lines 10–11" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it("is a bordered box of the smallest control height, set in mono", () => {
		render(Tag, { props: { children: lines } });

		expect(screen.getByRole("button")).toHaveClass(
			"inline-flex",
			"items-center",
			"gap-1",
			"h-control-xs",
			"px-2",
			"rounded",
			"border",
			"border-solid",
			"border-border",
			"font-mono",
			"text-small",
			"font-medium",
			"text-text-strong",
		);
	});

	it("takes the accent under the pointer", () => {
		render(Tag, { props: { children: lines } });

		expect(screen.getByRole("button")).toHaveClass(
			"hover:border-accent-border",
			"hover:text-accent-strong",
		);
	});

	it("reports a click to its caller", async () => {
		let clicks = 0;
		render(Tag, {
			props: {
				children: lines,
				onclick: () => {
					clicks += 1;
				},
			},
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toBe(1);
	});

	it("dims and refuses the press while disabled", () => {
		render(Tag, { props: { children: lines, disabled: true } });

		const tag = screen.getByRole("button");
		expect(tag).toBeDisabled();
		expect(tag).toHaveClass(
			"disabled:cursor-not-allowed",
			"disabled:text-text-subtle",
		);
	});

	describe("as a label", () => {
		it("names a span without being a control", () => {
			render(Tag, { props: { variant: "label", children: lines } });

			expect(screen.queryByRole("button")).toBeNull();
			expect(screen.getByText("Lines 10–11")).toBeVisible();
		});
	});

	describe("when dashed", () => {
		it("draws a dashed border in the sans face, for the whole of something", () => {
			render(Tag, { props: { dashed: true, children: lines } });

			const tag = screen.getByRole("button");
			expect(tag).toHaveClass("border-dashed", "font-sans", "text-text");
			expect(tag).not.toHaveClass("border-solid", "font-mono");
		});
	});
});
