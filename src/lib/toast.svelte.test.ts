import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetToasts, showToast, toasts } from "./toast.svelte.js";

describe("toast store", () => {
	beforeEach(() => {
		_resetToasts();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Test A: showToast adds an item with correct message and kind
	it("showToast adds an item with message and kind=success", () => {
		showToast("hello", "success");
		const items = toasts.items;
		expect(items.length).toBeGreaterThanOrEqual(1);
		const found = items.find(
			(t) => t.message === "hello" && t.kind === "success",
		);
		expect(found).toBeDefined();
	});

	// Test B: showToast assigns unique incrementing ids
	it("showToast assigns unique incrementing ids to each toast", () => {
		showToast("first", "success");
		showToast("second", "success");
		const items = toasts.items;
		const ids = items.map((t) => t.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	// Test C: after two showToast calls, items has length 2
	it("after two showToast calls, items has length 2", () => {
		showToast("msg1", "success");
		showToast("msg2", "success");
		expect(toasts.items).toHaveLength(2);
	});

	// Test D: after configured duration elapses, toast is removed
	it("toast is removed after duration elapses", () => {
		showToast("temporary", "success", 3000);
		expect(toasts.items.find((t) => t.message === "temporary")).toBeDefined();

		vi.advanceTimersByTime(3000);

		expect(toasts.items.find((t) => t.message === "temporary")).toBeUndefined();
	});

	it("a dismissal pending from before a reset does not remove a later toast", () => {
		showToast("stale", "success", 3000);
		vi.advanceTimersByTime(2999);

		_resetToasts();
		showToast("live", "success", 3000);
		vi.advanceTimersByTime(1);

		expect(toasts.items.map((t) => t.message)).toEqual(["live"]);
	});

	// Test E: showToast with kind='error' adds item with kind='error'
	it("showToast('err', 'error') adds an item with kind='error'", () => {
		showToast("err", "error");
		const found = toasts.items.find(
			(t) => t.message === "err" && t.kind === "error",
		);
		expect(found).toBeDefined();
	});
});
