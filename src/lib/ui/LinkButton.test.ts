import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import LinkButton from "./LinkButton.svelte";

const label = createRawSnippet(() => ({
	render: () => "<span>abc1234</span>",
}));

describe("LinkButton", () => {
	it("is a button that reads as the text around it", () => {
		render(LinkButton, { props: { children: label } });

		const button = screen.getByRole("button", { name: "abc1234" });
		expect(button).toHaveAttribute("type", "button");
		expect(button).toHaveClass("text-inherit", "text-left");
		expect(button).not.toHaveClass("border", "rounded");
	});

	it("takes the accent and an underline under the pointer and the focus ring", () => {
		render(LinkButton, { props: { children: label } });

		expect(screen.getByRole("button")).toHaveClass(
			"hover:text-accent",
			"hover:underline",
			"focus-visible:underline",
		);
	});

	it("reads muted when told to", () => {
		render(LinkButton, { props: { tone: "muted", children: label } });

		expect(screen.getByRole("button")).toHaveClass("text-text-muted");
	});

	it.each([
		["accent", "text-accent"],
		["danger", "text-danger"],
	] as const)(
		"paints the %s tone and keeps it under the pointer",
		(tone, paint) => {
			render(LinkButton, { props: { tone, children: label } });

			const button = screen.getByRole("button");
			expect(button).toHaveClass(paint, "hover:underline");
			expect(button).not.toHaveClass("hover:text-accent");
		},
	);

	it("sets a ref in the mono face when told to", () => {
		render(LinkButton, { props: { mono: true, children: label } });

		expect(screen.getByRole("button")).toHaveClass("font-mono");
	});

	it("cuts a long label with an ellipsis when told to", () => {
		render(LinkButton, { props: { truncate: true, children: label } });

		const button = screen.getByRole("button");
		expect(button).toHaveClass("truncate", "block", "w-full");
	});

	it("keeps its label on one line otherwise", () => {
		render(LinkButton, { props: { children: label } });

		expect(screen.getByRole("button")).not.toHaveClass("truncate", "block");
	});

	it("reports a click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(LinkButton, {
			props: { onclick: (event) => clicks.push(event), children: label },
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toHaveLength(1);
	});
});
