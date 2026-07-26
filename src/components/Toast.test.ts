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

	it("exposes the dismiss action as a focusable control", () => {
		showToast("Dismiss me", "success");
		render(Toast);

		const dismiss = screen.getByRole("button", {
			name: "Dismiss notification",
		});
		dismiss.focus();

		expect(document.activeElement).toBe(dismiss);
	});

	it.each(["success", "error"] as const)(
		"dismisses a %s toast when it is clicked",
		async (kind) => {
			showToast("Dismiss me", kind);
			render(Toast);

			await fireEvent.click(
				screen.getByRole("button", { name: "Dismiss notification" }),
			);

			expect(
				toasts.items.find((t) => t.message === "Dismiss me"),
			).toBeUndefined();
		},
	);

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
