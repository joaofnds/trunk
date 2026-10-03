import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import Tab from "./Tab.svelte";

const label = createRawSnippet(() => ({ render: () => "<span>Amend</span>" }));

describe("Tab", () => {
	it("is a tab that submits nothing", () => {
		render(Tab, { props: { children: label } });

		expect(screen.getByRole("tab", { name: "Amend" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it.each([true, false])(
		"tells assistive tech whether it is selected: %s",
		(selected) => {
			render(Tab, { props: { selected, children: label } });

			expect(screen.getByRole("tab")).toHaveAttribute(
				"aria-selected",
				String(selected),
			);
		},
	);

	it("is not selected unless the caller says so", () => {
		render(Tab, { props: { children: label } });

		expect(screen.getByRole("tab")).toHaveAttribute("aria-selected", "false");
	});

	it("takes an equal share of the strip in the callout step", () => {
		render(Tab, { props: { children: label } });

		expect(screen.getByRole("tab")).toHaveClass(
			"flex-1",
			"p-0",
			"text-callout",
			"cursor-pointer",
		);
	});

	it("underlines the selected tab with the accent and strengthens its label", () => {
		render(Tab, { props: { children: label } });

		expect(screen.getByRole("tab")).toHaveClass(
			"border-b-2",
			"border-transparent",
			"text-text-subtle",
			"aria-selected:border-accent",
			"aria-selected:text-text-strong",
		);
	});

	it("drops the pointer cursor while disabled", () => {
		render(Tab, { props: { disabled: true, children: label } });

		const tab = screen.getByRole("tab");
		expect(tab).toBeDisabled();
		expect(tab).toHaveClass("disabled:cursor-default");
	});

	it("reports a click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(Tab, {
			props: { onclick: (event) => clicks.push(event), children: label },
		});

		await fireEvent.click(screen.getByRole("tab"));

		expect(clicks).toHaveLength(1);
	});
});
