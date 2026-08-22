import { describe, expect, it } from "vitest";
import { groupSamples, summarize } from "./perf-stats.js";

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

describe("groupSamples", () => {
	const samples = [
		{ name: "invoke:diff", ms: 100, kind: "span" as const, at: 1 },
		{ name: "invoke:diff", ms: 200, kind: "span" as const, at: 2 },
		{ name: "invoke:status", ms: 10, kind: "span" as const, at: 3 },
		{ name: "invoke:diff", ms: 50, kind: "frame-gap" as const, at: 4 },
	];

	it("keeps a name's spans and frame gaps apart", () => {
		const groups = groupSamples(samples);

		expect(groups.map((g) => `${g.kind}:${g.name}`)).toEqual([
			"span:invoke:diff",
			"frame-gap:invoke:diff",
			"span:invoke:status",
		]);
	});

	it("orders by total time spent rather than by sample count", () => {
		const groups = groupSamples(samples);

		expect(groups.map((g) => g.total)).toEqual([300, 50, 10]);
	});

	it("summarizes each group", () => {
		const groups = groupSamples(samples);

		expect(groups[0].summary.count).toBe(2);
		expect(groups[0].summary.max).toBe(200);
	});
});
