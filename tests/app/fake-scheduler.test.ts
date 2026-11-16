import { describe, expect, it } from "vitest";
import { FakeScheduler } from "./fakes/scheduler.js";

describe("the fake scheduler", () => {
	it("settles foreground work without advancing to future background polls", () => {
		const scheduler = new FakeScheduler();
		const fired: string[] = [];
		scheduler.setTimeout(() => fired.push("poll"), 15_000, {
			background: true,
		});
		scheduler.setTimeout(() => fired.push("refresh"), 200);

		scheduler.flushForeground();

		expect(fired).toEqual(["refresh"]);
		expect(scheduler.pendingForeground).toBe(0);
		expect(scheduler.pending).toBe(1);
	});

	it("fires due background work in order while settling a later foreground timer", () => {
		const scheduler = new FakeScheduler();
		const fired: number[] = [];
		scheduler.setTimeout(() => fired.push(scheduler.time), 100, {
			background: true,
		});
		scheduler.setTimeout(() => fired.push(scheduler.time), 200);

		scheduler.flushForeground();

		expect(fired).toEqual([100, 200]);
		expect(scheduler.time).toBe(200);
	});

	it("runs background polls when their deadline is explicitly advanced", () => {
		const scheduler = new FakeScheduler();
		let fired = false;
		scheduler.setTimeout(
			() => {
				fired = true;
			},
			15_000,
			{ background: true },
		);

		scheduler.advanceBy(15_000);

		expect(fired).toBe(true);
		expect(scheduler.pending).toBe(0);
	});

	it("holds an armed timer until the test fires it", () => {
		const scheduler = new FakeScheduler();
		let fired = false;

		scheduler.setTimeout(() => {
			fired = true;
		}, 200);

		expect(scheduler.pending).toBe(1);
		expect(fired).toBe(false);

		scheduler.flush();
		expect(fired).toBe(true);
	});

	it("never fires a timer that was cleared", () => {
		const scheduler = new FakeScheduler();
		let fired = false;

		const handle = scheduler.setTimeout(() => {
			fired = true;
		}, 200);
		scheduler.clearTimeout(handle);

		scheduler.flush();

		expect(scheduler.pending).toBe(0);
		expect(fired).toBe(false);
	});

	it("clears the one timer named, leaving the others armed", () => {
		const scheduler = new FakeScheduler();
		const fired: string[] = [];

		const first = scheduler.setTimeout(() => fired.push("first"), 200);
		scheduler.setTimeout(() => fired.push("second"), 200);
		scheduler.clearTimeout(first);

		scheduler.flush();

		expect(fired).toEqual(["second"]);
	});

	it("leaves a timer armed by a firing callback for the next flush", () => {
		const scheduler = new FakeScheduler();
		let rearmed = false;

		scheduler.setTimeout(() => {
			scheduler.setTimeout(() => {
				rearmed = true;
			}, 200);
		}, 200);

		scheduler.flush();
		expect(rearmed).toBe(false);
		expect(scheduler.pending).toBe(1);

		scheduler.flush();
		expect(rearmed).toBe(true);
	});
});
