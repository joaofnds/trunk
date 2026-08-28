#!/usr/bin/env bun
/**
 * Turns criterion's bencher output into the values the CI benchmark gate compares.
 *
 * Usage:
 *   bun run scripts/bench-gate.ts <criterion-bencher-output>
 *
 * Each benchmark is divided by the calibration benchmark of its workload class, so
 * the compared number carries the code's cost and not the runner's speed. See
 * docs/benchmark-gate.md.
 */

import { readFileSync } from "node:fs";
import { NormalizeError, normalize } from "./bench-normalize.js";

const input = process.argv[2];

if (!input) {
	console.error(
		"usage: bun run scripts/bench-gate.ts <criterion-bencher-output>",
	);
	process.exit(2);
}

try {
	console.log(normalize(readFileSync(input, "utf8")));
} catch (error) {
	if (error instanceof NormalizeError) {
		console.error(`bench-gate: ${error.message}`);
		process.exit(1);
	}

	throw error;
}
