import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import Chip from "./Chip.svelte";

const label = createRawSnippet(() => ({
	render: () => "<span>a1b2c3d</span>",
}));

const refName = createRawSnippet(() => ({
	render: () => "<span>main</span>",
}));

describe("Chip", () => {
	it("is a button that submits nothing", () => {
		render(Chip, { props: { children: label } });

		expect(screen.getByRole("button", { name: "a1b2c3d" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it("is a framed pill of the small control height, set in mono", () => {
		render(Chip, { props: { children: label } });

		expect(screen.getByRole("button")).toHaveClass(
			"inline-flex",
			"items-center",
			"gap-1",
			"h-control-sm",
			"pl-1",
			"pr-2",
			"rounded-full",
			"border",
			"font-mono",
			"text-small",
		);
	});

	it("tints with the accent unless a tone is named", () => {
		render(Chip, { props: { children: label } });

		expect(screen.getByRole("button")).toHaveClass(
			"bg-chip-accent-bg",
			"border-chip-accent-border",
			"text-accent-strong",
			"hover:bg-chip-accent-bg-hover",
		);
	});

	it("sits in the muted tint under the neutral tone", () => {
		render(Chip, { props: { tone: "neutral", children: label } });

		const chip = screen.getByRole("button");
		expect(chip).toHaveClass(
			"bg-muted-bg",
			"border-border",
			"text-text",
			"hover:bg-muted-bg-hover",
		);
		expect(chip).not.toHaveClass("bg-chip-accent-bg");
		expect(chip).not.toHaveClass("text-accent-strong");
	});

	it("takes the colour of the lane around it under the lane tone", () => {
		render(Chip, { props: { tone: "lane", children: refName } });

		const chip = screen.getByRole("button");
		expect(chip).toHaveClass("chip-lane");
		expect(chip).not.toHaveClass("bg-chip-accent-bg");
	});

	it("reports a click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(Chip, {
			props: { onclick: (event) => clicks.push(event), children: label },
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toHaveLength(1);
	});

	it("reports a right click to its caller", async () => {
		const menus: MouseEvent[] = [];
		render(Chip, {
			props: { oncontextmenu: (event) => menus.push(event), children: label },
		});

		await fireEvent.contextMenu(screen.getByRole("button"));

		expect(menus).toHaveLength(1);
	});

	it("keeps its whole width unless told to truncate", () => {
		render(Chip, { props: { children: label } });

		const chip = screen.getByRole("button");
		expect(chip).not.toHaveClass("min-w-0");
		expect(chip).not.toHaveClass("flex-1");
	});

	describe("when told to truncate", () => {
		it("takes an even share of its row, never past its whole width", () => {
			render(Chip, { props: { truncate: true, children: label } });

			expect(screen.getByRole("button")).toHaveClass(
				"min-w-0",
				"flex-1",
				"max-w-max",
			);
		});

		it("ends its name, not its glyph, in an ellipsis", () => {
			render(Chip, { props: { truncate: true, children: label } });

			expect(screen.getByRole("button")).toHaveClass("chip-truncate");
		});
	});

	describe("as a label", () => {
		it("names a ref without being a control", () => {
			render(Chip, { props: { variant: "label", children: refName } });

			expect(screen.queryByRole("button")).toBeNull();
			expect(screen.getByText("main")).toBeVisible();
		});

		it("draws the same tinted pill without the pressable cues", () => {
			const { container } = render(Chip, {
				props: { variant: "label", children: refName },
			});

			const chip = container.firstElementChild;
			expect(chip).toHaveClass(
				"inline-flex",
				"items-center",
				"gap-1",
				"h-control-sm",
				"px-2",
				"rounded-full",
				"border",
				"font-mono",
				"text-small",
				"bg-chip-accent-bg",
				"border-chip-accent-border",
				"text-accent-strong",
			);
			expect(chip).not.toHaveClass("cursor-pointer");
			expect(chip).not.toHaveClass("hover:bg-chip-accent-bg-hover");
		});
	});
});
