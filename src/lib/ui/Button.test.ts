import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { SHOW_DELAY_MS } from "../tooltip.js";
import Button from "./Button.svelte";

const label = createRawSnippet(() => ({ render: () => "<span>Save</span>" }));

describe("Button", () => {
	it("is a button that submits nothing unless told to", () => {
		render(Button, { props: { children: label } });

		expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it("submits the form it sits in when told to", () => {
		render(Button, { props: { type: "submit", children: label } });

		expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
	});

	it("draws the secondary outline unless a variant is named", () => {
		render(Button, { props: { children: label } });

		expect(screen.getByRole("button")).toHaveClass("border-border");
	});

	it.each([
		["primary", "bg-accent"],
		["ghost", "hover:bg-hover"],
		["accent", "bg-accent-bg"],
		["danger", "bg-danger-bg"],
		["success", "bg-success-bg"],
		["warning", "bg-warning-bg"],
	] as const)("paints the %s variant from its token", (variant, paint) => {
		render(Button, { props: { variant, children: label } });

		expect(screen.getByRole("button")).toHaveClass(paint);
	});

	it.each([
		["sm", "h-control-sm"],
		["md", "h-control"],
		["lg", "h-control-lg"],
	] as const)("stands %s at its control height", (size, height) => {
		render(Button, { props: { size, children: label } });

		expect(screen.getByRole("button")).toHaveClass(height);
	});

	it("stands at the medium control height unless a size is named", () => {
		render(Button, { props: { children: label } });

		expect(screen.getByRole("button")).toHaveClass("h-control");
	});

	it("squares an icon button to its height and drops the side padding", () => {
		render(Button, {
			props: { icon: true, "aria-label": "Undo", children: label },
		});

		const button = screen.getByRole("button", { name: "Undo" });
		expect(button).toHaveClass("w-control");
		expect(button).not.toHaveClass("px-3");
	});

	it("squares an xs icon button to the smallest control height", () => {
		render(Button, {
			props: { icon: true, size: "xs", "aria-label": "Close", children: label },
		});

		expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
			"h-control-xs",
			"w-control-xs",
		);
	});

	it("anchors a badge a caller places inside it", () => {
		render(Button, { props: { children: label } });

		expect(screen.getByRole("button")).toHaveClass("relative");
	});

	describe("when joined into a group", () => {
		it("leaves the frame and the height to the group", () => {
			render(Button, { props: { joined: true, children: label } });

			const button = screen.getByRole("button");
			expect(button).toHaveClass("rounded-none");
			expect(button).not.toHaveClass("rounded", "border", "h-control");
		});

		it("rounds only the corners at the group's ends", () => {
			render(Button, { props: { joined: true, children: label } });

			expect(screen.getByRole("button")).toHaveClass(
				"first:rounded-l",
				"last:rounded-r",
			);
		});
	});

	it("reports a click to its caller", async () => {
		const clicks: MouseEvent[] = [];
		render(Button, {
			props: { onclick: (event) => clicks.push(event), children: label },
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(clicks).toHaveLength(1);
	});

	it("passes its disabled state to the element", () => {
		render(Button, { props: { disabled: true, children: label } });

		expect(screen.getByRole("button")).toBeDisabled();
	});

	it("shows its tooltip after the hover delay", async () => {
		vi.useFakeTimers();
		render(Button, { props: { tooltip: "Undo", children: label } });

		await fireEvent.mouseEnter(screen.getByRole("button"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);

		expect(document.querySelector(".tooltip-pop")).toHaveTextContent("Undo");
		vi.useRealTimers();
	});
});
