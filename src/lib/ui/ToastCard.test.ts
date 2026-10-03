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

		expect(screen.getByRole("button")).toHaveClass(
			"bg-surface",
			"border-border",
			"text-text",
		);
	});

	it("paints as a failure under the danger tone", () => {
		render(ToastCard, { props: { tone: "danger", children: message } });

		expect(screen.getByRole("button")).toHaveClass(
			"bg-toast-error-bg",
			"border-danger-border",
			"text-danger",
		);
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
