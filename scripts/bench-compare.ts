#!/usr/bin/env bun
/**
 * Compares the base and head benchmark passes of one Benchmarks job.
 *
 * Usage:
 *   bun run scripts/bench-compare.ts <pass-directory>
 *
 * The directory holds base-output.txt and head-output.txt, criterion's bencher
 * output, and base-normalized.txt and head-normalized.txt, each normalized by its
 * own commit's bench-gate.ts. scripts/bench-ab.ts writes it, and the job uploads it
 * as an artifact, so a downloaded artifact compares the same way. Prints the ratio
 * table, appends it to the job summary when GITHUB_STEP_SUMMARY is set, and exits
 * 1 when a benchmark slowed past the threshold. See docs/benchmark-gate.md.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
	ComparisonError,
	compare,
	type PassOutput,
	summarize,
	THRESHOLD,
} from "./bench-comparison.js";
import { passFiles, type Side } from "./bench-passes.js";

const directory = process.argv[2];

if (!directory) {
	console.error("usage: bun run scripts/bench-compare.ts <pass-directory>");
	process.exit(2);
}

function read(path: string): string {
	if (!existsSync(path)) {
		throw new ComparisonError(`${path} is absent from the pass directory`);
	}

	return readFileSync(path, "utf8");
}

function outputOf(side: Side): PassOutput {
	const files = passFiles(directory, side);

	return { normalized: read(files.normalized), raw: read(files.raw) };
}

try {
	const comparison = compare({
		base: outputOf("base"),
		head: outputOf("head"),
	});
	const summary = summarize(comparison);

	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
	}

	if (comparison.regressions.length > 0) {
		const named = comparison.regressions
			.map((row) => `${row.name} ${row.ratio.toFixed(3)}x`)
			.join(", ");
		console.error(
			`bench-compare: slower than ${THRESHOLD.toFixed(2)}x the base: ${named}`,
		);
		process.exit(1);
	}
} catch (error) {
	if (error instanceof ComparisonError) {
		console.error(`bench-compare: ${error.message}`);
		process.exit(1);
	}

	throw error;
}
