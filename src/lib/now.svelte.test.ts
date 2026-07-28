import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentMinute } from "./now.svelte.js";

const pinnedNow = new Date("2026-07-28T10:28:37Z");
const threeHours = 3 * 60 * 60 * 1000;
const msToMinuteTop = 60_000 - (pinnedNow.getTime() % 60_000);

const disposers: Array<() => void> = [];

function subscribeToMinute(): { read: () => number } {
	let seen = 0;
	disposers.push(
		$effect.root(() => {
			$effect(() => {
				seen = currentMinute();
			});
		}),
	);
	flushSync();
	return {
		read: () => {
			flushSync();
			return seen;
		},
	};
}

function disposeAll(): void {
	for (const dispose of disposers.splice(0)) dispose();
}

describe("currentMinute", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(pinnedNow);
	});

	afterEach(() => {
		disposeAll();
		vi.useRealTimers();
	});

	it("reseeds when the first subscriber arrives", async () => {
		const first = subscribeToMinute();
		const seed = first.read();
		disposeAll();
		await tick();

		vi.setSystemTime(pinnedNow.getTime() + threeHours);
		const second = subscribeToMinute();

		expect(second.read() - seed).toBe(180);
	});

	it("advances at the top of the wall-clock minute", async () => {
		const clock = subscribeToMinute();
		const seed = clock.read();

		await vi.advanceTimersByTimeAsync(msToMinuteTop - 1);
		expect(clock.read()).toBe(seed);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(clock.read()).toBe(seed + 1);
	});

	it("keeps advancing on each following minute", async () => {
		const clock = subscribeToMinute();
		const seed = clock.read();

		await vi.advanceTimersByTimeAsync(msToMinuteTop + 999);
		expect(clock.read()).toBe(seed + 1);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(clock.read()).toBe(seed + 1);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(clock.read()).toBe(seed + 2);
	});

	it("recovers from a fire that lands late", async () => {
		const clock = subscribeToMinute();
		const seed = clock.read();

		vi.setSystemTime(pinnedNow.getTime() + threeHours);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(clock.read()).toBe(
			Math.floor((pinnedNow.getTime() + threeHours + 60_000) / 60_000),
		);
		expect(clock.read()).not.toBe(seed + 1);
	});
});
