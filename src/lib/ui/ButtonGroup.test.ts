import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import ButtonGroup from "./ButtonGroup.svelte";

const buttons = createRawSnippet(() => ({
	render: () => "<button>Pull</button><button>Options</button>",
}));

describe("ButtonGroup", () => {
	it("draws one neutral frame around its buttons unless a tone is named", () => {
		render(ButtonGroup, { props: { children: buttons } });

		const group = screen.getByRole("group");
		expect(group).toHaveClass("ring-border", "divide-border");
		expect(group).toContainElement(
			screen.getByRole("button", { name: "Pull" }),
		);
	});

	it("stands at the control height its joined buttons gave up", () => {
		render(ButtonGroup, { props: { children: buttons } });

		expect(screen.getByRole("group")).toHaveClass("h-control", "items-stretch");
	});

	it("paints the accent tone as the soft sleeve", () => {
		render(ButtonGroup, { props: { tone: "accent", children: buttons } });

		expect(screen.getByRole("group")).toHaveClass(
			"bg-accent-bg",
			"ring-accent-border",
		);
	});
});
