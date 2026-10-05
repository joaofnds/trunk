import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import GutterGrip from "./GutterGrip.svelte";

const numbers = createRawSnippet(() => ({
	render: () => "<span>12</span>",
}));

describe("GutterGrip", () => {
	it("is a button in the Tab order that submits nothing", () => {
		render(GutterGrip, { props: { children: numbers } });

		const grip = screen.getByRole("button", { name: "12" });
		expect(grip).toHaveAttribute("type", "button");
		expect(grip).toHaveAttribute("tabindex", "0");
	});

	it("hugs its line numbers and keeps them out of a text selection", () => {
		render(GutterGrip, { props: { children: numbers } });

		expect(screen.getByRole("button")).toHaveClass(
			"inline-flex",
			"shrink-0",
			"cursor-pointer",
			"select-none",
		);
	});

	it("draws the focus ring inside its own box, for the keyboard only", () => {
		render(GutterGrip, { props: { children: numbers } });

		expect(screen.getByRole("button")).toHaveClass(
			"rounded",
			"focus-visible:outline-2",
			"focus-visible:-outline-offset-2",
			"focus-visible:outline-accent",
		);
	});

	it("marks itself for the row that tints under a hovered grip", () => {
		render(GutterGrip, { props: { children: numbers } });

		expect(screen.getByRole("button")).toHaveAttribute("data-gutter-grip");
	});

	it("reports a press to its caller, which starts the drag", async () => {
		const presses: MouseEvent[] = [];
		render(GutterGrip, {
			props: { onmousedown: (event) => presses.push(event), children: numbers },
		});

		await fireEvent.mouseDown(screen.getByRole("button"));

		expect(presses).toHaveLength(1);
	});

	it("reports a key press to its caller", async () => {
		const keys: string[] = [];
		render(GutterGrip, {
			props: { onkeydown: (event) => keys.push(event.key), children: numbers },
		});

		await fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });

		expect(keys).toEqual(["Enter"]);
	});
});
