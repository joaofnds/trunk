import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import Dialog from "./Dialog.svelte";

const body = createRawSnippet(() => ({ render: () => "<p>Body</p>" }));

describe("Dialog", () => {
	it("is open as a modal named by its title from the moment it mounts", () => {
		render(Dialog, { props: { title: "Create Branch", children: body } });

		expect(
			screen.getByRole("dialog", { name: "Create Branch" }),
		).toHaveAttribute("open");
	});

	it("draws the raised surface in the one radius with the deep shadow", () => {
		render(Dialog, { props: { title: "Create Branch", children: body } });

		expect(screen.getByRole("dialog")).toHaveClass(
			"bg-surface-raised",
			"border-border",
			"rounded",
			"shadow-lg",
		);
	});

	it("stays centred where the reset would pin it to the corner", () => {
		render(Dialog, { props: { title: "Create Branch", children: body } });

		expect(screen.getByRole("dialog")).toHaveClass(
			"fixed",
			"inset-0",
			"m-auto",
			"w-fit",
		);
	});

	it("bounds a small dialog between the narrow pair unless a size is named", () => {
		render(Dialog, { props: { title: "Create Branch", children: body } });

		expect(screen.getByRole("dialog")).toHaveClass(
			"min-w-dialog-min",
			"max-w-dialog-max",
		);
	});

	it("bounds a medium dialog between the wide pair", () => {
		render(Dialog, {
			props: { title: "Merge commit message", size: "md", children: body },
		});

		expect(screen.getByRole("dialog")).toHaveClass(
			"min-w-dialog-lg-min",
			"max-w-dialog-lg-max",
		);
	});

	it("reports the element's cancel to its caller", async () => {
		const cancels: Event[] = [];
		render(Dialog, {
			props: {
				title: "Create Branch",
				oncancel: (event) => cancels.push(event),
				children: body,
			},
		});

		await fireEvent(screen.getByRole("dialog"), new Event("cancel"));

		expect(cancels).toHaveLength(1);
	});

	it("opens an anchored dialog with show, which leaves the rest of the app live", () => {
		const show = vi.spyOn(HTMLDialogElement.prototype, "show");
		const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
		onTestFinished(() => {
			vi.restoreAllMocks();
		});

		render(Dialog, {
			props: { title: "Reword", variant: "anchored", children: body },
		});

		expect(screen.getByRole("dialog", { name: "Reword" })).toHaveAttribute(
			"open",
		);
		expect(show).toHaveBeenCalledOnce();
		expect(showModal).not.toHaveBeenCalled();
	});

	it("lays an anchored dialog in the box its caller places, on the surface", () => {
		render(Dialog, {
			props: { title: "Reword", variant: "anchored", children: body },
		});

		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveClass("static", "m-0", "w-auto", "bg-surface");
		expect(dialog).not.toHaveClass("fixed", "bg-surface-raised");
	});

	it("titles an anchored dialog in the muted callout step at the 1.5 leading", () => {
		render(Dialog, {
			props: { title: "Reword", variant: "anchored", children: body },
		});

		expect(screen.getByRole("heading", { name: "Reword" })).toHaveClass(
			"text-callout",
			"leading-normal",
			"text-text-muted",
		);
	});

	it("passes a test id through to the element", () => {
		render(Dialog, {
			props: {
				title: "Create Branch",
				"data-testid": "editor",
				children: body,
			},
		});

		expect(screen.getByTestId("editor")).toBe(screen.getByRole("dialog"));
	});
});
