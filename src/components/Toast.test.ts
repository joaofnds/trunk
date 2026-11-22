import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Toast from "./Toast.svelte";
import "../__tests__/helpers/tauri-mock";
import { _resetToasts, showToast, toasts } from "../lib/toast.svelte.js";

describe("Toast", () => {
	beforeEach(() => {
		_resetToasts();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders nothing when no toasts", () => {
		render(Toast);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("renders toast message with role=status", () => {
		showToast("Hello", "success");
		render(Toast);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Hello");
	});

	it("renders error toast message", () => {
		showToast("Fail", "error");
		render(Toast);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Fail");
	});

	it("adds no whitespace of its own around a message of several lines", () => {
		const said = "hook declined\nfatal: The pre-rebase hook refused to rebase.";
		showToast(said, "error");

		render(Toast);

		expect(screen.getByRole("button").textContent).toBe(said);
	});

	it("exposes the dismiss action as a focusable control named for the message", () => {
		showToast("Dismiss me", "success");
		render(Toast);

		const dismiss = screen.getByRole("button", { name: "Dismiss me" });
		dismiss.focus();

		expect(document.activeElement).toBe(dismiss);
	});

	it.each(["success", "error"] as const)(
		"dismisses a %s toast when it is clicked",
		async (kind) => {
			showToast("Dismiss me", kind);
			render(Toast);

			await fireEvent.click(screen.getByRole("button", { name: "Dismiss me" }));

			expect(
				toasts.items.find((t) => t.message === "Dismiss me"),
			).toBeUndefined();
		},
	);

	it.each([
		["success", "bg-surface"],
		["error", "bg-toast-error-bg"],
	] as const)("paints the %s kind in its own tone", (kind, surface) => {
		showToast("Toned", kind);
		render(Toast);

		expect(screen.getByRole("button", { name: "Toned" })).toHaveClass(surface);
	});

	it("lets the pointer reach a toast while the stack passes it through", () => {
		showToast("Reach me", "success");
		render(Toast);

		expect(screen.getByRole("status")).toHaveClass("pointer-events-auto");
	});

	it("brings the clipped earlier notification into focus without dismissing it", async () => {
		showToast("Earlier", "error");
		showToast("Latest", "error");
		render(Toast);
		const firstCard = screen.getAllByRole("status")[0];
		const viewport = firstCard.parentElement?.parentElement;
		if (!viewport) throw new Error("Missing notification viewport");
		Object.defineProperty(viewport, "scrollHeight", { value: 180 });
		Object.defineProperty(viewport, "clientHeight", { value: 120 });
		vi.spyOn(firstCard, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, -60, 100, 90),
		);
		firstCard.scrollIntoView = vi.fn();
		await fireEvent.scroll(viewport);

		await fireEvent.click(
			screen.getByRole("button", { name: "1 earlier notification" }),
		);

		expect(screen.getByRole("button", { name: "Earlier" })).toHaveFocus();
		expect(firstCard.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
		expect(screen.getAllByRole("status")).toHaveLength(2);
	});

	it("renders multiple toasts", () => {
		showToast("First", "success");
		showToast("Second", "error");
		render(Toast);
		const statuses = screen.getAllByRole("status");
		expect(statuses).toHaveLength(2);
		expect(statuses[0]).toHaveTextContent("First");
		expect(statuses[1]).toHaveTextContent("Second");
	});
});
