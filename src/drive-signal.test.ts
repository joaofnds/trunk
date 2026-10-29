import { afterEach, describe, expect, it, vi } from "vitest";
import { Signal } from "./drive-signal.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("Signal", () => {
	it("lets every wait go at the release", async () => {
		const signal = new Signal();
		const first = signal.next("menu", 1_000);
		const second = signal.next("menu", 1_000);

		signal.release();

		await expect(Promise.all([first, second])).resolves.toEqual([
			undefined,
			undefined,
		]);
	});

	it("names what it waited for once the deadline passes", async () => {
		vi.useFakeTimers();
		const waiting = new Signal().next("context menu", 1_000);

		vi.advanceTimersByTime(1_000);

		await expect(waiting).rejects.toThrow("no context menu showed in 1000ms");
	});

	it("leaves no timer behind once released", async () => {
		vi.useFakeTimers();
		const signal = new Signal();
		const waiting = signal.next("menu", 1_000);

		signal.release();
		await waiting;

		expect(vi.getTimerCount()).toBe(0);
	});

	it("lets a later release pass a wait that timed out", async () => {
		vi.useFakeTimers();
		const signal = new Signal();
		const timedOut = signal.next("menu", 1_000).catch(() => "timed out");
		vi.advanceTimersByTime(1_000);
		const waiting = signal.next("menu", 1_000);

		signal.release();

		await expect(Promise.all([timedOut, waiting])).resolves.toEqual([
			"timed out",
			undefined,
		]);
	});
});
