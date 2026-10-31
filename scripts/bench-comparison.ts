import { benchmarkOf, parse, type Sample } from "./bench-normalize.js";

export class ComparisonError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComparisonError";
	}
}

export const THRESHOLD = 1.3;

export type PassOutput = {
	readonly normalized: string;
	readonly raw: string;
};

export type Row = {
	readonly name: string;
	readonly ratio: number;
	readonly rawRatio: number;
};

export type Comparison = {
	readonly rows: readonly Row[];
	readonly regressions: readonly Row[];
	readonly baseOnly: readonly string[];
	readonly headOnly: readonly string[];
};

function byName(output: string): Map<string, Sample> {
	return new Map(parse(output).map((sample) => [sample.name, sample]));
}

function rawValue(samples: Map<string, Sample>, name: string): number {
	const sample = samples.get(name);
	if (sample === undefined) {
		throw new ComparisonError(`${name} is absent from the raw output`);
	}

	return sample.value;
}

function exceeds(row: Row): boolean {
	return row.ratio > THRESHOLD;
}

export function compare(sides: {
	base: PassOutput;
	head: PassOutput;
}): Comparison {
	const base = byName(sides.base.normalized);
	const head = byName(sides.head.normalized);
	const baseRaw = byName(sides.base.raw);
	const headRaw = byName(sides.head.raw);

	const rows: Row[] = [];
	for (const [name, sample] of head) {
		const baseSample = base.get(name);
		if (baseSample === undefined) {
			continue;
		}

		const rawName = benchmarkOf(name);
		rows.push({
			name,
			ratio: sample.value / baseSample.value,
			rawRatio: rawValue(headRaw, rawName) / rawValue(baseRaw, rawName),
		});
	}

	return {
		rows,
		regressions: rows.filter(exceeds),
		baseOnly: [...base.keys()].filter((name) => !head.has(name)),
		headOnly: [...head.keys()].filter((name) => !base.has(name)),
	};
}

function verdictOf(row: Row): string {
	const threshold = `${THRESHOLD.toFixed(2)}x`;
	if (exceeds(row)) {
		return `slower than ${threshold}`;
	}

	return `within ${threshold}`;
}

export function summarize(comparison: Comparison): string {
	const lines = [
		"| Benchmark | Normalized | Raw | Verdict |",
		"|---|---|---|---|",
		...comparison.rows.map(
			(row) =>
				`| ${row.name} | ${row.ratio.toFixed(3)} | ${row.rawRatio.toFixed(3)} | ${verdictOf(row)} |`,
		),
	];

	const oneSided: string[] = [];
	if (comparison.baseOnly.length > 0) {
		oneSided.push(
			`Not gated, only in the base: ${comparison.baseOnly.join(", ")}`,
		);
	}
	if (comparison.headOnly.length > 0) {
		oneSided.push(
			`Not gated, only in the head: ${comparison.headOnly.join(", ")}`,
		);
	}

	if (oneSided.length === 0) {
		return lines.join("\n");
	}

	return [...lines, "", ...oneSided].join("\n");
}
