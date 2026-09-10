import { describe, expect, it } from "vitest";
import { createCoalescedTask } from "./coalesced-task.js";
import type { Scheduler } from "./scheduler.js";

class TestScheduler implements Scheduler {
	private now = 0;
	private nextHandle = 1;
	private timers = new Map<
		number,
		{ readonly at: number; readonly callback: () => void }
	>();

	setTimeout(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.now + delayMs, callback });
		return handle;
	}

	clearTimeout(handle: number): void {
		this.timers.delete(handle);
	}

	advanceBy(elapsedMs: number): void {
		const until = this.now + elapsedMs;
		for (;;) {
			const next = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= until)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (!next) break;
			this.now = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.now = until;
	}
}

function controlled(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
} {
	let resolve = () => {};
	let reject = (_reason: unknown) => {};
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("createCoalescedTask", () => {
	it("keeps the first deadline while invalidations continue", async () => {
		const scheduler = new TestScheduler();
		let runs = 0;
		const task = createCoalescedTask(scheduler, async () => {
			runs += 1;
		});

		task.invalidate();
		scheduler.advanceBy(150);
		task.invalidate();
		scheduler.advanceBy(49);
		expect(runs).toBe(0);

		scheduler.advanceBy(1);
		await Promise.resolve();
		expect(runs).toBe(1);
	});

	it("admits one catch-up run after busy invalidations", async () => {
		const scheduler = new TestScheduler();
		const first = controlled();
		let runs = 0;
		const task = createCoalescedTask(scheduler, () => {
			runs += 1;
			return runs === 1 ? first.promise : Promise.resolve();
		});

		task.invalidate();
		scheduler.advanceBy(200);
		for (let index = 0; index < 10; index += 1) task.invalidate();
		expect(runs).toBe(1);

		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		scheduler.advanceBy(199);
		expect(runs).toBe(1);

		scheduler.advanceBy(1);
		expect(runs).toBe(2);
	});

	it("retains one notification rerun without allocating completion work", async () => {
		const scheduler = new TestScheduler();
		const first = controlled();
		let runs = 0;
		const task = createCoalescedTask(scheduler, () => {
			runs += 1;
			return runs === 1 ? first.promise : Promise.resolve();
		});

		task.request();
		for (let index = 0; index < 1_000; index += 1) task.request();
		expect(runs).toBe(1);

		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		scheduler.advanceBy(200);
		expect(runs).toBe(2);
	});

	it("makes an explicit request wait for the run after active work", async () => {
		const scheduler = new TestScheduler();
		const first = controlled();
		const second = controlled();
		let runs = 0;
		const task = createCoalescedTask(scheduler, () => {
			runs += 1;
			return runs === 1 ? first.promise : second.promise;
		});

		const initial = task.run();
		let postActionFinished = false;
		const postAction = task.run().then(() => {
			postActionFinished = true;
		});
		first.resolve();
		await initial;
		expect(postActionFinished).toBe(false);

		scheduler.advanceBy(200);
		expect(runs).toBe(2);
		second.resolve();
		await postAction;
		expect(postActionFinished).toBe(true);
	});

	it("releases the running slot after a failure and catches up", async () => {
		const scheduler = new TestScheduler();
		const first = controlled();
		let runs = 0;
		const errors: unknown[] = [];
		const task = createCoalescedTask(
			scheduler,
			() => {
				runs += 1;
				return runs === 1 ? first.promise : Promise.resolve();
			},
			{ onError: (error) => errors.push(error) },
		);

		task.invalidate();
		scheduler.advanceBy(200);
		task.invalidate();
		first.reject(new Error("read failed"));
		await Promise.resolve();
		await Promise.resolve();
		scheduler.advanceBy(200);

		expect(runs).toBe(2);
		expect(errors).toHaveLength(1);
	});

	it("drops scheduled and catch-up work when disposed", async () => {
		const scheduler = new TestScheduler();
		const first = controlled();
		let runs = 0;
		const task = createCoalescedTask(scheduler, () => {
			runs += 1;
			return first.promise;
		});

		task.invalidate();
		scheduler.advanceBy(200);
		task.invalidate();
		task.dispose();
		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		scheduler.advanceBy(200);

		expect(runs).toBe(1);
		await expect(task.run()).resolves.toBeUndefined();
	});
});
