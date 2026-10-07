import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import RowAction from "./RowAction.svelte";

const glyph = createRawSnippet(() => ({
	render: () => "<svg aria-hidden='true'></svg>",
}));

describe("RowAction", () => {
	it("is a button named by its label that submits nothing", () => {
		render(RowAction, {
			props: { "aria-label": "Hide topic", children: glyph },
		});

		expect(screen.getByRole("button", { name: "Hide topic" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it("draws no frame, no fill and no padding of its own", () => {
		render(RowAction, {
			props: { "aria-label": "Hide topic", children: glyph },
		});

		const button = screen.getByRole("button");
		expect(button).toHaveClass("bg-transparent", "border-none", "p-0");
		expect(button).not.toHaveClass("rounded", "border");
	});

	it("fills the minimum hit target unless a size is named", () => {
		render(RowAction, {
			props: { "aria-label": "Hide topic", children: glyph },
		});

		expect(screen.getByRole("button")).toHaveClass(
			"min-w-target",
			"min-h-target",
		);
	});

	it("hugs its glyph inside the row's text line when compact", () => {
		render(RowAction, {
			props: { size: "compact", "aria-label": "Stage file", children: glyph },
		});

		const button = screen.getByRole("button");
		expect(button).toHaveClass("px-1", "leading-none");
		expect(button).not.toHaveClass("min-w-target", "min-h-target");
	});

	it("paints the subtle text color unless a tone is named", () => {
		render(RowAction, {
			props: { "aria-label": "Hide topic", children: glyph },
		});

		expect(screen.getByRole("button")).toHaveClass("text-text-subtle");
	});

	it.each([
		["muted", "text-text-muted"],
		["text", "text-text"],
		["success", "text-success"],
		["danger", "text-danger"],
	] as const)("paints the %s tone from its token", (tone, paint) => {
		render(RowAction, {
			props: { tone, "aria-label": "Hide topic", children: glyph },
		});

		expect(screen.getByRole("button")).toHaveClass(paint);
	});

	it.each([
		["subtle", "hover:text-text"],
		["muted", "hover:text-text"],
		["text", "hover:text-text-strong"],
	] as const)("brightens the %s tone under the pointer", (tone, hover) => {
		render(RowAction, {
			props: { tone, "aria-label": "Hide topic", children: glyph },
		});

		expect(screen.getByRole("button")).toHaveClass(hover);
	});

	it("rests subtle in the destructive tone and turns danger when pointed at", () => {
		render(RowAction, {
			props: {
				tone: "destructive",
				"aria-label": "Delete comment",
				children: glyph,
			},
		});

		const button = screen.getByRole("button");
		expect(button).toHaveClass(
			"text-text-subtle",
			"hover:text-danger",
			"focus-visible:text-danger",
		);
		expect(button).not.toHaveClass("text-danger");
	});

	it("reports a click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(RowAction, {
			props: {
				"aria-label": "Hide topic",
				onclick: (event) => clicks.push(event),
				children: glyph,
			},
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toHaveLength(1);
	});
});
