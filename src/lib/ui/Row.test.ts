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

	it("claims no selection outside a list or a tree", () => {
		render(Row, { props: { "aria-label": "topic", children: name } });

		expect(screen.getByRole("button", { name: "topic" })).not.toHaveAttribute(
			"aria-selected",
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

	it("leaves its actions hidden under focus when only the pointer reveals them", () => {
		render(Row, {
			props: {
				reveal: "pointer",
				"aria-label": "topic",
				children: name,
				actions: eye,
			},
		});

		const actions = screen.getByRole("button", {
			name: "Hide topic",
		}).parentElement;
		expect(actions).toHaveClass("hidden", "group-hover:flex");
		expect(actions).not.toHaveClass("group-focus-within:flex");
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

	describe("when it is an entry of a list that stands alone", () => {
		it("grows with its label inside its padding and paints the hover color", () => {
			const { container } = render(Row, {
				props: { variant: "entry", "aria-label": "trunk", children: name },
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass("rounded", "hover:bg-hover");
			expect(row).not.toHaveClass("h-row");
			expect(container.querySelector("button > span")).toHaveClass(
				"pl-3",
				"py-2",
			);
		});

		it("fades its actions in under the pointer or focus and keeps their width", () => {
			const { container } = render(Row, {
				props: {
					variant: "entry",
					reveal: "fade",
					"aria-label": "trunk",
					children: name,
					actions: eye,
				},
			});

			const shown = screen.getByLabelText("Hide topic").parentElement;
			expect(shown).toHaveClass(
				"flex",
				"opacity-0",
				"group-hover:opacity-100",
				"group-focus-within:opacity-100",
			);
			expect(shown).not.toHaveClass("hidden");
			expect(container.querySelector("button + div")).toHaveClass("pr-3");
		});

		describe("with a detail", () => {
			const detail = createRawSnippet(() => ({
				render: () => "<span>r7k2</span>",
			}));

			it("lays the detail on a second line inside the primary button", () => {
				render(Row, {
					props: {
						variant: "entry",
						"aria-label": "trunk",
						children: name,
						detail,
					},
				});

				const line = screen.getByText("r7k2").parentElement;
				expect(screen.getByRole("button", { name: "trunk" })).toContainElement(
					line,
				);
				expect(line).toHaveClass("row-start-2", "col-span-2", "pl-3", "pb-2");
			});

			it("runs the detail under the actions, which stay on the label's line", () => {
				const { container } = render(Row, {
					props: {
						variant: "entry",
						reveal: "fade",
						"aria-label": "trunk",
						children: name,
						detail,
						actions: eye,
					},
				});

				expect(container.querySelector("button")).toHaveClass(
					"row-span-2",
					"grid-rows-subgrid",
				);
				expect(container.querySelector("button > span")).toHaveClass(
					"pl-3",
					"pt-2",
				);
				expect(container.querySelector("button > span")).not.toHaveClass(
					"py-2",
				);
				expect(container.querySelector("button + div")).toHaveClass(
					"row-start-1",
				);
			});
		});
	});

	describe("when it names the rows under it in a scrolling list", () => {
		it("fills its frame as a surface bar with a hairline and a medium label", () => {
			const { container } = render(Row, {
				props: {
					variant: "title",
					"aria-label": "src/main.ts",
					children: name,
				},
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass(
				"size-full",
				"bg-surface",
				"shadow-hairline",
				"font-medium",
			);
			expect(row).not.toHaveClass("hover:bg-hover", "h-row", "h-bar");
			expect(container.querySelector("button > span")).toHaveClass("px-2");
		});
	});

	describe("when it parts two runs of rows", () => {
		it("fills its frame as a surface bar ruled above and below", () => {
			const { container } = render(Row, {
				props: {
					variant: "divider",
					tone: "muted",
					"aria-label": "Conflict 1",
					children: name,
				},
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass(
				"size-full",
				"bg-surface",
				"row-ruled",
				"text-text-muted",
			);
			expect(row).not.toHaveClass("hover:bg-hover", "h-row", "h-bar");
			expect(container.querySelector("button > span")).toHaveClass("px-2");
		});
	});

	describe("when it fills a frame its caller sizes and paints", () => {
		it("takes the frame's whole box and adds no padding or hover color", () => {
			const { container } = render(Row, {
				props: { variant: "fill", "aria-label": "Conflict 1", children: name },
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass("size-full");
			expect(row).not.toHaveClass("hover:bg-hover", "h-row", "h-bar");
			expect(container.querySelector("button > span")?.className).not.toMatch(
				/\bp[lxy]-/,
			);
			expect(container.querySelector("button + div")?.className).not.toMatch(
				/\bpr-|\bmin-w-2\b/,
			);
		});
	});

	describe("when it is an item of a list or a tree", () => {
		it("takes the row height, the hover color and the pointer", () => {
			const { container } = render(Row, {
				props: { variant: "item", "aria-label": "a.ts", children: name },
			});

			expect(container.firstElementChild).toHaveClass(
				"h-row",
				"hover:bg-hover",
			);
			expect(screen.getByRole("button", { name: "a.ts" })).toHaveClass(
				"cursor-pointer",
			);
		});

		it("indents its label by the length it is handed", () => {
			const { container } = render(Row, {
				props: {
					variant: "item",
					indent: "40px",
					"aria-label": "a.ts",
					children: name,
				},
			});

			const label = container.querySelector<HTMLElement>("button > span");
			expect(label?.style.paddingLeft).toBe("40px");
		});

		it("insets its actions from the edge it runs to", () => {
			const { container } = render(Row, {
				props: {
					variant: "item",
					"aria-label": "a.ts",
					children: name,
					actions: eye,
				},
			});

			expect(container.querySelector("button + div")).toHaveClass("pr-2");
		});
	});

	describe("when it folds the items under it", () => {
		it("takes the row height, the surface color under the pointer and the pointer", () => {
			const { container } = render(Row, {
				props: { variant: "parent", "aria-label": "src", children: name },
			});

			const row = container.firstElementChild;
			expect(row).toHaveClass("h-row", "hover:bg-surface");
			expect(row).not.toHaveClass("hover:bg-hover");
			expect(screen.getByRole("button", { name: "src" })).toHaveClass(
				"cursor-pointer",
			);
		});

		it("indents its label by the length it is handed", () => {
			const { container } = render(Row, {
				props: {
					variant: "parent",
					indent: "24px",
					"aria-label": "src",
					children: name,
				},
			});

			const label = container.querySelector<HTMLElement>("button > span");
			expect(label?.style.paddingLeft).toBe("24px");
		});
	});

	describe("when a list or a tree owns it", () => {
		it.each(["option", "treeitem"] as const)(
			"takes the %s role in place of the button's",
			(role) => {
				render(Row, {
					props: {
						role,
						selected: false,
						"aria-label": "a.ts",
						children: name,
					},
				});

				expect(screen.getByRole(role, { name: "a.ts" })).toHaveAttribute(
					"aria-selected",
					"false",
				);
			},
		);

		it("paints the selected one, which the pointer does not change", () => {
			const { container } = render(Row, {
				props: {
					variant: "item",
					role: "option",
					selected: true,
					"aria-label": "a.ts",
					children: name,
				},
			});

			const row = container.firstElementChild;
			expect(
				screen.getByRole("option", { selected: true }),
			).toBeInTheDocument();
			expect(row).toHaveClass("bg-selected-row");
			expect(row).not.toHaveClass("hover:bg-hover");
		});
	});
});
