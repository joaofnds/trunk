import { describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { AutofetchScheduler } from "./autofetch.js";
import { realScheduler } from "./scheduler.js";

class ObservedScheduler extends FakeScheduler {
	private timerObservers: Array<() => void> = [];

	whenArmed(): Promise<void> {
		return new Promise((resolve) => this.timerObservers.push(resolve));
	}

	override setTimeout(callback: () => void, delayMs: number): number {
		const handle = super.setTimeout(callback, delayMs);
		for (const observer of this.timerObservers.splice(0)) observer();
		return handle;
	}
}

class Fetches {
	readonly started: string[] = [];
	private completions: Array<() => void> = [];

	fetch = (path: string): Promise<void> => {
		this.started.push(path);
		return new Promise<void>((resolve) => this.completions.push(resolve));
	};

	async finish(clock: ObservedScheduler): Promise<void> {
		const complete = this.completions.shift();
		if (!complete) throw new Error("no fetch is awaiting completion");
		const armed = clock.whenArmed();
		complete();
		await armed;
	}
}

describe("AutofetchScheduler", () => {
	it.each(["before opening", "after restoration"] as const)(
		"staggers distinct deadlines when the interval loads %s",
		async (preferenceTiming) => {
			const clock = new ObservedScheduler();
			const fetches = new Fetches();
			const task = new AutofetchScheduler(
				clock,
				() => clock.time,
				fetches.fetch,
			);
			const repositories = {
				paths: ["a", "b", "c", "d", "e"],
				activePath: "e",
				focused: true,
				manualBusy: false,
			};
			if (preferenceTiming === "before opening") task.setInterval(60_000);
			task.update(repositories);
			if (preferenceTiming === "after restoration") {
				clock.advanceBy(15_000);
				expect(clock.pending).toBe(0);
				task.setInterval(60_000);
			}

			const expected: string[] = [];
			for (const next of repositories.paths) {
				expect(clock.pending).toBe(1);
				clock.advanceBy(11_999);
				expect(fetches.started).toEqual(expected);
				clock.advanceBy(1);
				expected.push(next);
				expect(fetches.started).toEqual(expected);
				expect(clock.pending).toBe(0);
				await fetches.finish(clock);
			}
			expect(clock.pending).toBe(1);
			task.dispose();
		},
	);

	it("admits one fetch while several deadlines accumulate", async () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const task = new AutofetchScheduler(clock, () => clock.time, fetches.fetch);
		task.setInterval(60_000);
		task.update({
			paths: ["a", "b", "c"],
			activePath: "c",
			focused: true,
			manualBusy: false,
		});

		clock.advanceBy(20_000);
		clock.advanceBy(180_000);
		expect(fetches.started).toEqual(["a"]);
		expect(clock.pending).toBe(0);
		await fetches.finish(clock);
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["a", "b"]);
		await fetches.finish(clock);
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["a", "b", "c"]);
		await fetches.finish(clock);

		expect(clock.pending).toBe(1);
		task.dispose();
	});

	it("keeps the production elapsed-time deadline when wall time moves backward", () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const elapsed = vi
			.spyOn(performance, "now")
			.mockImplementation(() => clock.time);
		const wall = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		const now = realScheduler.currentTimeMs;
		const task = new AutofetchScheduler(clock, now, fetches.fetch);
		try {
			task.setInterval(60_000);
			task.update({
				paths: ["a"],
				activePath: "a",
				focused: true,
				manualBusy: false,
			});

			clock.advanceBy(59_999);
			wall.mockReturnValue(500_000);
			expect(fetches.started).toEqual([]);
			clock.advanceBy(1);

			expect(fetches.started).toEqual(["a"]);
		} finally {
			task.dispose();
			wall.mockRestore();
			elapsed.mockRestore();
		}
	});

	it("prefers a newer due active tab but admits the oldest within one interval", async () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const task = new AutofetchScheduler(clock, () => clock.time, fetches.fetch);
		const repositories = {
			paths: ["a", "b", "c"],
			activePath: "c",
			focused: false,
			manualBusy: false,
		};
		task.setInterval(60_000);
		task.update(repositories);
		clock.advanceBy(60_000);

		task.update({ ...repositories, focused: true });
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["c"]);
		clock.advanceBy(20_000);
		task.update({ ...repositories, activePath: "b", focused: true });
		await fetches.finish(clock);
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["c", "a"]);
		await fetches.finish(clock);
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["c", "a", "b"]);
		await fetches.finish(clock);

		expect(clock.pending).toBe(1);
		task.dispose();
	});

	it("resumes overdue tabs once and schedules from completion", async () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const task = new AutofetchScheduler(clock, () => clock.time, fetches.fetch);
		const repositories = {
			paths: ["a", "b"],
			activePath: "b",
			focused: false,
			manualBusy: false,
		};
		task.setInterval(60_000);
		task.update(repositories);
		clock.advanceBy(180_000);
		expect(clock.pending).toBe(0);

		task.update({ ...repositories, focused: true });
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["a"]);
		await fetches.finish(clock);
		clock.advanceBy(0);
		expect(fetches.started).toEqual(["a", "b"]);
		await fetches.finish(clock);
		clock.advanceBy(59_999);
		expect(fetches.started).toEqual(["a", "b"]);
		clock.advanceBy(1);
		expect(fetches.started).toEqual(["a", "b", "b"]);
		task.dispose();
	});

	it("manual work disarms automatic checks until it finishes", () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const task = new AutofetchScheduler(clock, () => clock.time, fetches.fetch);
		const repositories = {
			paths: ["a"],
			activePath: "a",
			focused: true,
			manualBusy: true,
		};
		task.setInterval(60_000);
		task.update(repositories);
		clock.advanceBy(60_000);
		expect(fetches.started).toEqual([]);

		task.checked("a");
		task.update({ ...repositories, manualBusy: false });
		clock.advanceBy(59_999);
		expect(fetches.started).toEqual([]);
		clock.advanceBy(1);
		expect(fetches.started).toEqual(["a"]);
		task.dispose();
	});

	it("a completion from a closed tab cannot postpone its reopened session", async () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const task = new AutofetchScheduler(clock, () => clock.time, fetches.fetch);
		const repositories = {
			paths: ["a"],
			activePath: "a",
			focused: true,
			manualBusy: false,
		};
		task.setInterval(60_000);
		task.update(repositories);
		clock.advanceBy(60_000);
		task.update({ ...repositories, paths: [] });
		task.update(repositories);
		clock.advanceBy(60_000);

		await fetches.finish(clock);
		clock.advanceBy(0);

		expect(fetches.started).toEqual(["a", "a"]);
		task.dispose();
	});

	it("live disable and focus loss remove the pending deadline", () => {
		const clock = new ObservedScheduler();
		const fetches = new Fetches();
		const task = new AutofetchScheduler(clock, () => clock.time, fetches.fetch);
		const repositories = {
			paths: ["a"],
			activePath: "a",
			focused: true,
			manualBusy: false,
		};
		task.setInterval(60_000);
		task.update(repositories);
		task.update({ ...repositories, focused: false });
		expect(clock.pending).toBe(0);
		task.update(repositories);
		task.setInterval(0);
		clock.advanceBy(180_000);

		expect(clock.pending).toBe(0);
		expect(fetches.started).toEqual([]);
		task.dispose();
	});
});
