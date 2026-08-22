import { afterEach, describe, expect, it } from "vitest";
import {
	disablePerf,
	enablePerf,
	flushPerf,
	type PerfSink,
	record,
	recordFrameGap,
	span,
} from "./perf.js";

class FakeSink implements PerfSink {
	readonly batches: string[][] = [];

	async write(lines: string[]): Promise<void> {
		this.batches.push(lines);
	}

	/** Without the wall clock, which is what every case here is not about. */
	samples(): { name: string; ms: number; kind: string }[] {
		return this.raw().map(({ at: _at, ...rest }) => rest);
	}

	raw(): { name: string; ms: number; kind: string; at: number }[] {
		return this.batches.flat().map((line) => JSON.parse(line));
	}
}

/** A clock the test advances, so a duration is a stated number rather than
 *  whatever the machine took. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
	let t = 1000;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
	};
}

afterEach(disablePerf);

describe("perf", () => {
	it("records nothing while instrumentation is off", async () => {
		const sink = new FakeSink();

		record("anything", 5);
		await flushPerf();

		expect(sink.batches.length).toBe(0);
	});

	it("still returns a span's value while instrumentation is off", async () => {
		expect(await span("anything", () => 42)).toBe(42);
	});

	it("writes a recorded duration through the sink on flush", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });

		record("open-diff", 12.5);
		await flushPerf();

		expect(sink.samples()).toEqual([
			{ name: "open-diff", ms: 12.5, kind: "span" },
		]);
	});

	it("times a span against the injected clock", async () => {
		const sink = new FakeSink();
		const clock = fakeClock();
		enablePerf({ sink, now: clock.now, frames: false });

		await span("open-diff", () => clock.advance(30));
		await flushPerf();

		expect(sink.samples()[0]).toEqual({
			name: "open-diff",
			ms: 30,
			kind: "span",
		});
	});

	it("records a span that threw, and rethrows", async () => {
		const sink = new FakeSink();
		const clock = fakeClock();
		enablePerf({ sink, now: clock.now, frames: false });

		await expect(
			span("open-diff", () => {
				clock.advance(7);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await flushPerf();

		expect(sink.samples()[0]).toEqual({
			name: "open-diff",
			ms: 7,
			kind: "span",
		});
	});

	it("attributes a frame gap to the span that was open", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });

		await span("open-diff", () => recordFrameGap(150));
		await flushPerf();

		const gap = sink.samples().find((s) => s.kind === "frame-gap");
		expect(gap).toEqual({ name: "open-diff", ms: 150, kind: "frame-gap" });
	});

	it("attributes a frame gap outside any span to idle", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });

		recordFrameGap(20);
		await flushPerf();

		expect(sink.samples()[0]).toEqual({
			name: "idle",
			ms: 20,
			kind: "frame-gap",
		});
	});

	it("writes each sample once across repeated flushes", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });

		record("open-diff", 1);
		await flushPerf();
		await flushPerf();

		expect(sink.samples().length).toBe(1);
	});

	it("stamps every sample with the wall clock", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });

		const before = Date.now();
		record("open-diff", 1);
		await flushPerf();

		expect(sink.raw()[0].at).toBeGreaterThanOrEqual(before);
	});

	it("stops recording once instrumentation is turned off", async () => {
		const sink = new FakeSink();
		enablePerf({ sink, frames: false });

		disablePerf();
		record("open-diff", 1);
		await flushPerf();

		expect(sink.samples().length).toBe(0);
	});
});
