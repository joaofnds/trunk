import type { PerfSample, SampleKind } from "./perf.js";

/** Distribution of one operation's durations, in milliseconds. Pure: the report
 *  script and any in-app display read the same numbers from the same code. */
export interface Summary {
	count: number;
	mean: number;
	min: number;
	p50: number;
	p90: number;
	p95: number;
	p99: number;
	max: number;
}

export function summarize(samples: readonly number[]): Summary {
	if (samples.length === 0) {
		throw new Error("cannot summarize: no samples");
	}

	const sorted = [...samples].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);

	return {
		count: sorted.length,
		mean: total / sorted.length,
		min: sorted[0],
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted[sorted.length - 1],
	};
}

/** Nearest rank: the smallest value at or above which `p` percent of the samples
 *  fall. No interpolation, so every reported number is one the app actually
 *  measured. */
function percentile(sorted: readonly number[], p: number): number {
	const rank = Math.ceil((p / 100) * sorted.length);

	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface PerfGroup {
	name: string;
	kind: SampleKind;
	/** Milliseconds this operation accounted for across the session. */
	total: number;
	summary: Summary;
}

/** One row per operation, worst first. Total time rather than count, because
 *  the operation to look at is the one the session spent longest in, not the
 *  one it called most. */
export function groupSamples(samples: readonly PerfSample[]): PerfGroup[] {
	const byKey = new Map<
		string,
		{ name: string; kind: SampleKind; ms: number[] }
	>();

	for (const sample of samples) {
		const key = `${sample.kind}\u0000${sample.name}`;
		const group = byKey.get(key) ?? {
			name: sample.name,
			kind: sample.kind,
			ms: [],
		};
		group.ms.push(sample.ms);
		byKey.set(key, group);
	}

	return [...byKey.values()]
		.map((group) => ({
			name: group.name,
			kind: group.kind,
			total: group.ms.reduce((sum, value) => sum + value, 0),
			summary: summarize(group.ms),
		}))
		.sort((a, b) => b.total - a.total);
}
