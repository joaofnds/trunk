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

	it("leaves a strip tab's place in the Tab order to its caller", () => {
		render(Tab, { props: { children: label } });

		expect(screen.getByRole("tab")).not.toHaveAttribute("tabindex");
	});

	describe("framed", () => {
		it("fills its frame's one cell as the whole target", () => {
			render(Tab, { props: { variant: "framed", children: label } });

			expect(screen.getByRole("tab", { name: "Amend" })).toHaveClass(
				"col-start-1",
				"row-start-1",
				"rounded",
				"cursor-pointer",
			);
		});

		it.each([
			"flex-1",
			"border-b-2",
			"text-callout",
			"text-text-subtle",
			"aria-selected:text-text-strong",
			"focus-visible:outline-2",
		])("leaves the strip's %s to the caller's frame", (stripClass) => {
			render(Tab, { props: { variant: "framed", children: label } });

			expect(screen.getByRole("tab")).not.toHaveClass(stripClass);
		});

		it("lays its label on one line, stepped in from the edge", () => {
			render(Tab, { props: { variant: "framed", children: label } });

			expect(screen.getByRole("tab")).toHaveClass(
				"flex",
				"items-center",
				"gap-2",
				"pl-3",
			);
		});

		it("keeps room after its label for an xs control laid over its trailing edge", () => {
			render(Tab, { props: { variant: "framed", children: label } });

			expect(screen.getByRole("tab")).toHaveClass(
				"after:w-control-xs",
				"after:shrink-0",
				"pr-2",
			);
		});

		it("sizes itself from its label alone, with no track borrowed from the frame", () => {
			render(Tab, { props: { variant: "framed", children: label } });

			expect(screen.getByRole("tab")).not.toHaveClass("grid-cols-subgrid");
		});

		it("joins the Tab order", () => {
			render(Tab, { props: { variant: "framed", children: label } });

			expect(screen.getByRole("tab")).toHaveAttribute("tabindex", "0");
		});

		it("takes the place in the Tab order its caller gives it", () => {
			render(Tab, {
				props: { variant: "framed", tabindex: -1, children: label },
			});

			expect(screen.getByRole("tab")).toHaveAttribute("tabindex", "-1");
		});
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
