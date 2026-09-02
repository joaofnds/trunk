import { describe, expect, it } from "vitest";
import { FakeScheduler } from "./fakes/scheduler.js";

describe("the fake scheduler", () => {
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
