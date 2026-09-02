import { describe, expect, it, vi } from "vitest";
import { realScheduler } from "./scheduler.js";

describe("the real scheduler", () => {
	it("fires the callback once the delay has passed", async () => {
		vi.useFakeTimers();
		let fired = false;

		realScheduler.setTimeout(() => {
			fired = true;
		}, 200);

		await vi.advanceTimersByTimeAsync(199);
		expect(fired).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(fired).toBe(true);

		vi.useRealTimers();
	});

	it("never fires a callback whose timer was cleared", async () => {
		vi.useFakeTimers();
		let fired = false;

		const handle = realScheduler.setTimeout(() => {
			fired = true;
		}, 200);
		realScheduler.clearTimeout(handle);

		await vi.advanceTimersByTimeAsync(500);

		expect(fired).toBe(false);
		vi.useRealTimers();
	});

	it("uses the timers installed when the call is made, not the ones present at import", () => {
		const installed = vi.fn().mockReturnValue(7);
		const original = globalThis.setTimeout;
		globalThis.setTimeout =
			installed as unknown as typeof globalThis.setTimeout;

		const handle = realScheduler.setTimeout(() => {}, 200);

		expect(installed).toHaveBeenCalledOnce();
		expect(handle).toBe(7);
		globalThis.setTimeout = original;
	});
});
