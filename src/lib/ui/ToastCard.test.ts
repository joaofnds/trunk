import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import ToastCard from "./ToastCard.svelte";

const message = createRawSnippet(() => ({
	render: () => "<span>Pushed main to origin</span>",
}));

describe("ToastCard", () => {
	it("is a button named by its message that submits nothing", () => {
		render(ToastCard, { props: { children: message } });

		expect(
			screen.getByRole("button", { name: "Pushed main to origin" }),
		).toHaveAttribute("type", "button");
	});

	it("fills its row as a raised card in body type", () => {
		render(ToastCard, { props: { children: message } });

		expect(screen.getByRole("button")).toHaveClass(
			"block",
			"w-full",
			"text-left",
			"px-4",
			"py-2",
			"rounded",
			"border",
			"text-body",
			"font-medium",
			"shadow-lg",
		);
	});

	it("paints as news unless a tone is named", () => {
		render(ToastCard, { props: { children: message } });

		const card = screen.getByRole("button");
		expect(card).toHaveClass("bg-surface", "border-border", "text-text");
		expect(card).not.toHaveClass("bg-toast-error-bg");
	});

	it("shows a pointer and the shared focus ring", () => {
		render(ToastCard, { props: { children: message } });

		expect(screen.getByRole("button")).toHaveClass(
			"cursor-pointer",
			"focus-visible:outline-2",
			"focus-visible:outline-offset-1",
			"focus-visible:outline-accent",
		);
	});

	it("paints as a failure under the danger tone", () => {
		render(ToastCard, { props: { tone: "danger", children: message } });

		const card = screen.getByRole("button");
		expect(card).toHaveClass(
			"bg-toast-error-bg",
			"border-danger-border",
			"text-danger",
		);
		expect(card).not.toHaveClass("bg-surface");
	});

	it("reports a click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(ToastCard, {
			props: { onclick: (event) => clicks.push(event), children: message },
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toHaveLength(1);
	});
});
