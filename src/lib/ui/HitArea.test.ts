import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import HitArea from "./HitArea.svelte";

describe("HitArea", () => {
	it("is a named button that submits nothing", () => {
		render(HitArea, { props: { "aria-label": "main" } });

		expect(screen.getByRole("button", { name: "main" })).toHaveAttribute(
			"type",
			"button",
		);
	});

	it("stays out of the Tab order", () => {
		render(HitArea, { props: { "aria-label": "main" } });

		expect(screen.getByRole("button")).toHaveAttribute("tabindex", "-1");
	});

	it("fills the box it is placed in and takes the pointer there", () => {
		render(HitArea, { props: { "aria-label": "main" } });

		expect(screen.getByRole("button")).toHaveClass(
			"size-full",
			"pointer-events-auto",
		);
	});

	it.each([
		{ cursor: "pointer", className: "cursor-pointer" },
		{ cursor: "context-menu", className: "cursor-context-menu" },
	] as const)(
		"shows the $cursor cursor when asked",
		({ cursor, className }) => {
			render(HitArea, { props: { "aria-label": "main", cursor } });

			expect(screen.getByRole("button")).toHaveClass(className);
		},
	);

	it("keeps what it holds aligned to the start, as text outside a button is", () => {
		render(HitArea, { props: { "aria-label": "main" } });

		expect(screen.getByRole("button")).toHaveClass("text-start");
	});

	it("leaves the cursor alone when none is asked for", () => {
		render(HitArea, { props: { "aria-label": "main" } });

		const area = screen.getByRole("button");
		expect(area).not.toHaveClass("cursor-pointer");
		expect(area).not.toHaveClass("cursor-context-menu");
	});

	it.each([
		{ shape: "pill", className: "rounded-full" },
		{ shape: "row", className: "rounded" },
	] as const)("is rounded as a $shape", ({ shape, className }) => {
		render(HitArea, { props: { "aria-label": "main", shape } });

		expect(screen.getByRole("button")).toHaveClass(className);
	});

	it("reports the pointer entering and leaving to its caller", async () => {
		const seen: string[] = [];
		render(HitArea, {
			props: {
				"aria-label": "main",
				onmouseenter: () => seen.push("enter"),
				onmouseleave: () => seen.push("leave"),
			},
		});

		await fireEvent.mouseEnter(screen.getByRole("button"));
		await fireEvent.mouseLeave(screen.getByRole("button"));

		expect(seen).toEqual(["enter", "leave"]);
	});

	it("reports a right click and a double click to its caller", async () => {
		const seen: string[] = [];
		render(HitArea, {
			props: {
				"aria-label": "main",
				oncontextmenu: () => seen.push("contextmenu"),
				ondblclick: () => seen.push("dblclick"),
			},
		});

		await fireEvent.contextMenu(screen.getByRole("button"));
		await fireEvent.dblClick(screen.getByRole("button"));

		expect(seen).toEqual(["contextmenu", "dblclick"]);
	});

	it("is a menu item when its caller says so", () => {
		render(HitArea, { props: { "aria-label": "main", role: "menuitem" } });

		expect(screen.getByRole("menuitem", { name: "main" })).toBeInTheDocument();
	});
});
