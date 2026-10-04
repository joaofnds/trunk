import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import Row from "./Row.svelte";

const name = createRawSnippet(() => ({
	render: () => "<span>topic</span>",
}));

const eye = createRawSnippet(() => ({
	render: () => "<button type='button' aria-label='Hide topic'></button>",
}));

describe("Row", () => {
	it("draws one primary button named by its label that submits nothing", () => {
		render(Row, { props: { "aria-label": "topic", children: name } });

		expect(screen.getByRole("button", { name: "topic" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	// WebKit leaves a plain button out of the Tab order and does not focus it on a
	// click. An explicit tabindex makes it take both, as the rows did before they
	// were buttons.
	it("puts the primary button in the tab order by an explicit tabindex", () => {
		render(Row, { props: { "aria-label": "topic", children: name } });

		expect(screen.getByRole("button", { name: "topic" })).toHaveAttribute(
			"tabindex",
			"0",
		);
	});

	it("draws its actions beside the primary button, never inside it", () => {
		render(Row, {
			props: { "aria-label": "topic", children: name, actions: eye },
		});

		const primary = screen.getByRole("button", { name: "topic" });
		const action = screen.getByRole("button", { name: "Hide topic" });
		expect(primary).not.toContainElement(action);
	});

	it("keeps a click on an action away from the primary button", async () => {
		const clicks: MouseEvent[] = [];
		render(Row, {
			props: {
				"aria-label": "topic",
				onclick: (event) => clicks.push(event),
				children: name,
				actions: eye,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: "Hide topic" }));

		expect(clicks).toHaveLength(0);
	});

	it.each([
		["click", "onclick"],
		["dblClick", "ondblclick"],
		["contextMenu", "oncontextmenu"],
	] as const)(
		"reports a %s on the row to its caller",
		async (gesture, prop) => {
			const seen: Event[] = [];
			render(Row, {
				props: {
					"aria-label": "topic",
					[prop]: (event: Event) => seen.push(event),
					children: name,
				},
			});

			await fireEvent[gesture](screen.getByRole("button", { name: "topic" }));

			expect(seen).toHaveLength(1);
		},
	);

	it("paints the hover color under the pointer unless a tone is named", () => {
		const { container } = render(Row, {
			props: { "aria-label": "topic", children: name },
		});

		expect(container.firstElementChild).toHaveClass(
			"text-text",
			"hover:bg-hover",
		);
	});

	it("mutes its text and still paints the hover color when muted", () => {
		const { container } = render(Row, {
			props: { tone: "muted", "aria-label": "topic", children: name },
		});

		expect(container.firstElementChild).toHaveClass(
			"text-text-muted",
			"hover:bg-hover",
		);
	});

	it("keeps the current tone's tint under the pointer", () => {
		const { container } = render(Row, {
			props: { tone: "current", "aria-label": "topic", children: name },
		});

		const row = container.firstElementChild;
		expect(row).toHaveClass("row-current", "text-text-strong", "font-semibold");
		expect(row).not.toHaveClass("hover:bg-hover");
	});

	it("reveals its actions under the pointer or focus unless told to keep them", () => {
		render(Row, {
			props: { "aria-label": "topic", children: name, actions: eye },
		});

		expect(
			screen.getByRole("button", { name: "Hide topic" }).parentElement,
		).toHaveClass("hidden", "group-hover:flex", "group-focus-within:flex");
	});

	it("keeps its actions in the row when they are always shown", () => {
		render(Row, {
			props: {
				reveal: "always",
				"aria-label": "topic",
				children: name,
				actions: eye,
			},
		});

		const actions = screen.getByRole("button", {
			name: "Hide topic",
		}).parentElement;
		expect(actions).toHaveClass("flex");
		expect(actions).not.toHaveClass("hidden");
	});

	// The row's right inset is the action column's minimum width, so the label
	// runs to the same edge with no action as it stops short of with one.
	it("holds the right inset in the action column when it has no actions", () => {
		const { container } = render(Row, {
			props: { "aria-label": "topic", children: name },
		});

		expect(container.querySelector("button + div")).toHaveClass("min-w-2");
	});

	describe("when it heads a section", () => {
		it("takes the bar height and the full width, with no hover color", () => {
			const { container } = render(Row, {
				props: { variant: "header", "aria-label": "Branches", children: name },
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass("h-bar");
			expect(row).not.toHaveClass("h-row", "mx-2", "hover:bg-hover");
		});

		// A header runs edge to edge, so its actions are inset from the edge by
		// padding and land in the column the rows under it put theirs in.
		it("insets its actions from the edge it runs to", () => {
			const { container } = render(Row, {
				props: {
					variant: "header",
					"aria-label": "Branches",
					children: name,
					actions: eye,
				},
			});

			expect(container.querySelector("button + div")).toHaveClass("pr-2");
		});
	});

	describe("when it runs flush with the list's edges", () => {
		it("takes the row height, the full width and the hover color", () => {
			const { container } = render(Row, {
				props: { variant: "flush", "aria-label": "stash", children: name },
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass("h-row", "hover:bg-hover");
			expect(row).not.toHaveClass("mx-2", "rounded");
		});

		it("insets its actions from the edge it runs to", () => {
			const { container } = render(Row, {
				props: {
					variant: "flush",
					"aria-label": "stash",
					children: name,
					actions: eye,
				},
			});

			expect(container.querySelector("button + div")).toHaveClass("pr-2");
		});

		// A flush row navigates rather than acts, and keeps the arrow the list
		// around it shows.
		it("keeps the default cursor", () => {
			render(Row, {
				props: { variant: "flush", "aria-label": "stash", children: name },
			});

			const primary = screen.getByRole("button", { name: "stash" });
			expect(primary).toHaveClass("cursor-default");
			expect(primary).not.toHaveClass("cursor-pointer");
		});
	});

	describe("when it heads a panel's section", () => {
		it("takes the bar height and paints the hairline, with no hover color", () => {
			const { container } = render(Row, {
				props: { variant: "band", "aria-label": "Staged", children: name },
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass("h-bar", "shadow-hairline");
			expect(row).not.toHaveClass("hover:bg-hover");
		});

		it("insets its actions from the edge it runs to", () => {
			const { container } = render(Row, {
				props: {
					variant: "band",
					"aria-label": "Staged",
					children: name,
					actions: eye,
				},
			});

			expect(container.querySelector("button + div")).toHaveClass("pr-2");
		});
	});
});
