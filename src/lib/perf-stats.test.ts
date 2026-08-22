import { describe, expect, it } from "vitest";
import { summarize } from "./perf-stats.js";

describe("summarize", () => {
	it("counts the samples and reports their mean and extremes", () => {
		const summary = summarize([10, 20, 30, 40]);

		expect({
			count: summary.count,
			mean: summary.mean,
			min: summary.min,
			max: summary.max,
		}).toEqual({ count: 4, mean: 25, min: 10, max: 40 });
	});

	it("reports percentiles by nearest rank", () => {
		const samples = Array.from({ length: 100 }, (_, index) => index + 1);

		const summary = summarize(samples);

		expect({
			p50: summary.p50,
			p90: summary.p90,
			p95: summary.p95,
			p99: summary.p99,
		}).toEqual({ p50: 50, p90: 90, p95: 95, p99: 99 });
	});

	it("reads every percentile off a single sample", () => {
		const summary = summarize([7]);

		expect([summary.p50, summary.p95, summary.p99, summary.max]).toEqual([
			7, 7, 7, 7,
		]);
	});

	it("leaves the caller's array in its original order", () => {
		const samples = [30, 10, 20];

		summarize(samples);

		expect(samples).toEqual([30, 10, 20]);
	});

	it("refuses an empty sample set rather than reporting zeroes", () => {
		expect(() => summarize([])).toThrow(/no samples/);
	});
});
