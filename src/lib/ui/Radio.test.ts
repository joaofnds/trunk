import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Radio from "./Radio.svelte";

describe("Radio", () => {
	it("is a button that reports whether it is the chosen one", () => {
		render(Radio, { props: { checked: true, "aria-label": "Active review" } });

		const radio = screen.getByRole("button", { name: "Active review" });
		expect(radio).toHaveAttribute("type", "button");
		expect(radio).toHaveAttribute("aria-pressed", "true");
	});

	it("is unpressed while another is chosen", () => {
		render(Radio, { props: { checked: false, "aria-label": "Active review" } });

		expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
	});

	it("reports a press to its caller", async () => {
		let presses = 0;
		render(Radio, {
			props: {
				checked: false,
				"aria-label": "Active review",
				onclick: () => {
					presses += 1;
				},
			},
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(presses).toBe(1);
	});

	it("draws a focus ring", () => {
		render(Radio, { props: { checked: false, "aria-label": "Active review" } });

		expect(screen.getByRole("button")).toHaveClass(
			"focus-visible:outline-2",
			"focus-visible:outline-accent",
		);
	});

	describe("as a mark", () => {
		it("draws the chosen dot without being a control", () => {
			const { container } = render(Radio, {
				props: { variant: "mark", checked: true },
			});

			expect(screen.queryByRole("button")).toBeNull();
			expect(container.querySelector("[data-checked]")).not.toBeNull();
		});
	});
});
