import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Splitter, { type SplitterVariant } from "./Splitter.svelte";

function renderSplitter(variant: SplitterVariant) {
	const steps: number[] = [];
	render(Splitter, {
		props: {
			variant,
			value: 220,
			min: 0,
			max: 600,
			"aria-label": "Resize sidebar",
			onstep: (delta) => steps.push(delta),
		},
	});

	return { steps, splitter: screen.getByRole("slider") };
}

describe("Splitter", () => {
	it.each([
		{ variant: "pane", key: "ArrowRight", step: 8 },
		{ variant: "pane", key: "ArrowLeft", step: -8 },
		{ variant: "column", key: "ArrowRight", step: 8 },
		{ variant: "column", key: "ArrowLeft", step: -8 },
		{ variant: "bar", key: "ArrowDown", step: 8 },
		{ variant: "bar", key: "ArrowUp", step: -8 },
	] as const)(
		"reports a step of $step pixels on $key for a $variant",
		async ({ variant, key, step }) => {
			const { steps, splitter } = renderSplitter(variant);

			await fireEvent.keyDown(splitter, { key });

			expect(steps).toEqual([step]);
		},
	);

	it.each([
		{ variant: "pane", key: "ArrowUp" },
		{ variant: "pane", key: "ArrowDown" },
		{ variant: "column", key: "ArrowUp" },
		{ variant: "bar", key: "ArrowLeft" },
		{ variant: "bar", key: "ArrowRight" },
		{ variant: "pane", key: "Enter" },
	] as const)(
		"leaves $key on a $variant to whatever is listening above it",
		async ({ variant, key }) => {
			const { steps, splitter } = renderSplitter(variant);

			const unhandled = await fireEvent.keyDown(splitter, { key });

			expect(steps).toEqual([]);
			expect(unhandled).toBe(true);
		},
	);

	it("keeps a key it answered from scrolling the page or reaching a list above it", async () => {
		const { splitter } = renderSplitter("pane");
		const bubbled: string[] = [];
		document.body.addEventListener(
			"keydown",
			(event) => bubbled.push(event.key),
			{ once: true },
		);

		const unhandled = await fireEvent.keyDown(splitter, { key: "ArrowRight" });

		expect(unhandled).toBe(false);
		expect(bubbled).toEqual([]);
	});

	it("is a named slider in the Tab order", () => {
		const { splitter } = renderSplitter("pane");

		expect(splitter).toHaveAccessibleName("Resize sidebar");
		expect(splitter).toHaveAttribute("tabindex", "0");
	});

	it("tells assistive tech its size and the limits it moves between", () => {
		const { splitter } = renderSplitter("pane");

		expect(splitter).toHaveAttribute("aria-valuenow", "220");
		expect(splitter).toHaveAttribute("aria-valuemin", "0");
		expect(splitter).toHaveAttribute("aria-valuemax", "600");
	});

	it("tells assistive tech whole pixels for a size measured in fractions", () => {
		render(Splitter, {
			props: {
				variant: "column",
				value: 176.4,
				min: 38.78,
				max: 399.5,
				onstep: () => {},
			},
		});
		const splitter = screen.getByRole("slider");

		expect(splitter).toHaveAttribute("aria-valuenow", "176");
		expect(splitter).toHaveAttribute("aria-valuemin", "39");
		expect(splitter).toHaveAttribute("aria-valuemax", "400");
	});

	it("states no upper limit where its caller has none", () => {
		render(Splitter, {
			props: { variant: "column", value: 220, min: 20, onstep: () => {} },
		});

		expect(screen.getByRole("slider")).not.toHaveAttribute("aria-valuemax");
	});

	it.each([
		{ variant: "pane", orientation: "horizontal" },
		{ variant: "column", orientation: "horizontal" },
		{ variant: "bar", orientation: "vertical" },
	] as const)(
		"moves along the $orientation axis as a $variant",
		({ variant, orientation }) => {
			const { splitter } = renderSplitter(variant);

			expect(splitter).toHaveAttribute("aria-orientation", orientation);
		},
	);

	it("is a strip between two panes that keeps its width", () => {
		const { splitter } = renderSplitter("pane");

		expect(splitter).toHaveClass(
			"splitter-pane",
			"w-1",
			"shrink-0",
			"cursor-col-resize",
		);
	});

	it("lies over the trailing edge of a column's header cell", () => {
		const { splitter } = renderSplitter("column");

		expect(splitter).toHaveClass(
			"splitter-column",
			"absolute",
			"inset-y-0",
			"right-0",
			"w-1",
			"cursor-col-resize",
		);
	});

	it("is a strip across a panel that keeps its height", () => {
		const { splitter } = renderSplitter("bar");

		expect(splitter).toHaveClass(
			"splitter-bar",
			"h-1",
			"shrink-0",
			"cursor-row-resize",
		);
	});

	it.each(["pane", "column", "bar"] as const)(
		"draws the focus ring inside a %s, for the keyboard only",
		(variant) => {
			const { splitter } = renderSplitter(variant);

			expect(splitter).toHaveClass(
				"focus-visible:outline-2",
				"focus-visible:-outline-offset-2",
				"focus-visible:outline-accent",
			);
		},
	);

	it("reports a press to its caller, which starts the drag", async () => {
		const presses: MouseEvent[] = [];
		render(Splitter, {
			props: {
				variant: "pane",
				value: 220,
				min: 0,
				onstep: () => {},
				onmousedown: (event) => presses.push(event),
			},
		});

		await fireEvent.mouseDown(screen.getByRole("slider"));

		expect(presses).toHaveLength(1);
	});

	it("reports a double click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(Splitter, {
			props: {
				variant: "column",
				value: 220,
				min: 0,
				onstep: () => {},
				ondblclick: (event) => clicks.push(event),
			},
		});

		await fireEvent.dblClick(screen.getByRole("slider"));

		expect(clicks).toHaveLength(1);
	});

	it("is a strip that is no control where nothing can be resized", () => {
		const { container } = render(Splitter, {
			props: { variant: "bar", fixed: true },
		});
		const strip = container.querySelector("div");

		expect(screen.queryByRole("slider")).toBeNull();
		expect(strip).toHaveClass("splitter-bar", "h-1", "shrink-0");
		expect(strip).not.toHaveClass("cursor-row-resize");
		expect(strip).not.toHaveAttribute("tabindex");
	});

	it("leaves the layout and the Tab order while hidden", () => {
		render(Splitter, {
			props: {
				variant: "pane",
				value: 0,
				min: 0,
				hidden: true,
				onstep: () => {},
			},
		});

		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.getByRole("slider", { hidden: true })).not.toBeVisible();
	});
});
