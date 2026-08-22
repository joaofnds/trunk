#!/usr/bin/env bun
/**
 * Turns a perf session's raw samples into per-operation distributions.
 *
 * Usage:
 *   bun run scripts/perf-report.ts [--over <ms>] [--file <path>]
 *
 * `--over` additionally lists every individual sample at or above a threshold,
 * in the order they happened, which is how a single stall gets attributed to
 * the operation that caused it.
 */

import { readFileSync } from "node:fs";
import type { PerfSample } from "../src/lib/perf.js";
import { groupSamples } from "../src/lib/perf-stats.js";

const DEFAULT_FILE = "/tmp/trunk-perf/samples.jsonl";

function arg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function readSamples(file: string): PerfSample[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as PerfSample);
}

function ms(value: number): string {
	return value.toFixed(1);
}

/** The dimensions of one measurement, which is what turns "this was slow" into
 *  "this was slow on that input". */
function describe(attrs: PerfSample["attrs"]): string {
	if (!attrs) return "";

	return Object.entries(attrs)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
}

function table(rows: string[][]): string {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length)),
	);

	return rows
		.map((row) =>
			row
				.map((cell, column) =>
					column === 0
						? cell.padEnd(widths[column])
						: cell.padStart(widths[column]),
				)
				.join("  "),
		)
		.join("\n");
}

const file = arg("file") ?? DEFAULT_FILE;
const over = arg("over");

let samples: PerfSample[];
try {
	samples = readSamples(file);
} catch {
	console.error(
		`no samples at ${file} — run \`just perf\` and exercise the app`,
	);
	process.exit(1);
}

if (samples.length === 0) {
	console.error(`${file} is empty — exercise the app, then rerun`);
	process.exit(1);
}

const groups = groupSamples(samples);
const span =
	samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0;

console.log(
	`${samples.length} samples over ${(span / 1000).toFixed(1)}s from ${file}\n`,
);
console.log(
	table([
		[
			"operation",
			"kind",
			"n",
			"mean",
			"p50",
			"p90",
			"p95",
			"p99",
			"max",
			"total",
		],
		...groups.map((group) => [
			group.name,
			group.kind,
			String(group.summary.count),
			ms(group.summary.mean),
			ms(group.summary.p50),
			ms(group.summary.p90),
			ms(group.summary.p95),
			ms(group.summary.p99),
			ms(group.summary.max),
			ms(group.total),
		]),
	]),
);

if (over !== null) {
	const threshold = Number(over);
	const worst = samples.filter((sample) => sample.ms >= threshold);

	console.log(
		`\n${worst.length} samples at or over ${threshold}ms, in order:\n`,
	);
	console.log(
		table([
			["operation", "kind", "ms", "at", "attributes"],
			...worst.map((sample) => [
				sample.name,
				sample.kind,
				ms(sample.ms),
				new Date(sample.at).toISOString().slice(11, 23),
				describe(sample.attrs),
			]),
		]),
	);
}
