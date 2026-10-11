import { afterEach, expect, it, vi } from "vitest";
import { realScheduler } from "./scheduler.js";

afterEach(() => vi.useRealTimers());

it("reads the production scheduler clock from monotonic elapsed time", () => {
	const before = performance.now();
	const now = realScheduler.currentTimeMs();
	const after = performance.now();

	expect(now).toBeGreaterThanOrEqual(before);
	expect(now).toBeLessThanOrEqual(after);
});

it("fires the retained callback and cancels the removed callback", () => {
	vi.useFakeTimers();
	const fired: string[] = [];
	const cancelled = realScheduler.setTimeout(() => fired.push("cancelled"), 20);
	realScheduler.setTimeout(() => fired.push("retained"), 10);

	realScheduler.clearTimeout(cancelled);
	vi.advanceTimersByTime(20);

	expect(fired).toEqual(["retained"]);
});
