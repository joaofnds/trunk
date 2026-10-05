import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import ListOption from "./ListOption.svelte";

const label = createRawSnippet(() => ({
	render: () => "<span>src/main.rs</span>",
}));

describe("ListOption", () => {
	it.each(["option", "menuitem"] as const)(
		"submits nothing as a %s",
		(role) => {
			render(ListOption, { props: { role, children: label } });

			expect(screen.getByRole(role)).toHaveAttribute("type", "button");
		},
	);

	it.each([true, false])(
		"tells assistive tech whether it is selected: %s",
		(selected) => {
			render(ListOption, { props: { selected, children: label } });

			expect(screen.getByRole("option")).toHaveAttribute(
				"aria-selected",
				String(selected),
			);
		},
	);

	it("carries no selected state when the caller gives none", () => {
		render(ListOption, { props: { children: label } });

		expect(screen.getByRole("option")).not.toHaveAttribute("aria-selected");
	});

	it("is a menu item when its list is a menu", () => {
		render(ListOption, { props: { role: "menuitem", children: label } });

		expect(screen.getByRole("menuitem")).toBeInTheDocument();
	});

	it("fills the list's width as a left-aligned row in the list's type", () => {
		render(ListOption, { props: { children: label } });

		const option = screen.getByRole("option");
		expect(option).toHaveClass(
			"flex",
			"w-full",
			"items-center",
			"gap-2",
			"py-2",
			"px-3",
			"text-left",
			"text-text",
		);
		expect(option).not.toHaveClass("text-callout", "text-body");
	});

	it("stacks its lines when the layout is stack", () => {
		render(ListOption, { props: { layout: "stack", children: label } });

		const option = screen.getByRole("option");
		expect(option).toHaveClass("flex-col", "gap-1");
		expect(option).not.toHaveClass("items-center", "gap-2");
	});

	it("paints its selection with the selected-row color unless a highlight is named", () => {
		render(ListOption, { props: { selected: true, children: label } });

		expect(screen.getByRole("option")).toHaveClass(
			"aria-selected:bg-selected-row",
		);
	});

	it("paints its selection with the hover color under the hover highlight", () => {
		render(ListOption, {
			props: { highlight: "hover", selected: true, children: label },
		});

		const option = screen.getByRole("option");
		expect(option).toHaveClass("aria-selected:bg-hover");
		expect(option).not.toHaveClass("aria-selected:bg-selected-row");
	});

	it("fills with the accent under the pointer as a menu item", () => {
		render(ListOption, { props: { role: "menuitem", children: label } });

		const item = screen.getByRole("menuitem");
		expect(item).toHaveClass("hover:bg-accent", "hover:text-on-accent");
		expect(item).not.toHaveClass("aria-selected:bg-selected-row");
	});

	it.each(["option", "menuitem"] as const)(
		"reports a click to its caller as a %s",
		async (role) => {
			const clicks: MouseEvent[] = [];
			render(ListOption, {
				props: {
					role,
					onclick: (event: MouseEvent) => clicks.push(event),
					children: label,
				},
			});

			await fireEvent.click(screen.getByRole(role));

			expect(clicks).toHaveLength(1);
		},
	);
});
