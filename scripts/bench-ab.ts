#!/usr/bin/env bun
/**
 * Benchmarks a base commit and HEAD in one job, on one runner, and compares them.
 *
 * Usage:
 *   bun run scripts/bench-ab.ts <before-sha> <pass-directory> [criterion-filter]
 *
 * <before-sha> is the commit main held before the push (github.event.before).
 * scripts/bench-base.ts picks the base from it. The base's tree is exported to a
 * temporary directory, which leaves the repository's git state untouched, and each
 * side benches the bench targets its own Cargo.toml declares, with the toolchain its
 * own mise.toml pins, normalized by its own bench-gate.ts. Both raw and both
 * normalized outputs land in <pass-directory> for scripts/bench-compare.ts and the
 * artifact upload. Each pass cleans the workspace crates first and fails if cargo
 * still reports reusing one, since both sides share one target directory. A failed
 * base pass warns and skips the comparison; a failed head pass fails the run. The filter is criterion's, for a local trial run; it must keep
 * the calibrations. See docs/benchmark-gate.md.
 */

import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chooseBase } from "./bench-base.js";
import {
	outcomeOf,
	passFiles,
	type Side,
	type WorkspaceBuild,
	workspaceBuildOf,
} from "./bench-passes.js";

const [before, passDirectory, filter] = process.argv.slice(2);

if (!before || !passDirectory) {
	console.error(
		"usage: bun run scripts/bench-ab.ts <before-sha> <pass-directory> [criterion-filter]",
	);
	process.exit(2);
}

const BENCH_TARGETS = ["--bench", "*"];
const output = resolve(passDirectory);
const repository = process.cwd();
const targetDir = join(repository, "src-tauri", "target");

function run(step: {
	command: string[];
	cwd: string;
	stdout?: string;
}): boolean {
	console.log(`$ ${step.command.join(" ")}  (in ${step.cwd})`);
	const destination =
		step.stdout === undefined ? "inherit" : openSync(step.stdout, "w");
	const result = spawnSync(step.command[0], step.command.slice(1), {
		cwd: step.cwd,
		stdio: ["ignore", destination, "inherit"],
	});
	if (typeof destination === "number") {
		closeSync(destination);
	}

	if (result.error) {
		console.error(
			`bench-ab: ${step.command[0]} did not start: ${result.error}`,
		);
	} else if (result.signal) {
		console.error(`bench-ab: ${step.command[0]} died on ${result.signal}`);
	}

	return result.status === 0;
}

function revParse(revision: string): string {
	const result = spawnSync("git", ["rev-parse", "--verify", revision], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`git rev-parse ${revision} failed: ${result.stderr}`);
	}

	return result.stdout.trim();
}

function isAncestor(pair: { ancestor: string; descendant: string }): boolean {
	const result = spawnSync(
		"git",
		["merge-base", "--is-ancestor", pair.ancestor, pair.descendant],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);

	return result.status === 0;
}

function exportTree(tree: {
	sha: string;
	archive: string;
	checkout: string;
}): boolean {
	mkdirSync(tree.checkout);

	return (
		run({
			command: ["git", "archive", "--output", tree.archive, tree.sha],
			cwd: repository,
		}) &&
		run({
			command: ["tar", "-x", "-f", tree.archive, "-C", tree.checkout],
			cwd: repository,
		})
	);
}

function compiledItsOwnCrates(side: Side, buildMessages: string): boolean {
	let build: WorkspaceBuild;
	try {
		build = workspaceBuildOf(readFileSync(buildMessages, "utf8"));
	} catch (error) {
		console.error(
			`bench-ab: cannot read the ${side} pass's build messages: ${error}`,
		);
		return false;
	}

	if (build.compiled.length === 0) {
		console.error(
			`bench-ab: the ${side} pass's build messages name no workspace crate it compiled`,
		);
		return false;
	}

	if (build.reused.length > 0) {
		console.error(
			`bench-ab: the ${side} pass reused workspace crates an earlier build compiled: ${build.reused.join(", ")}`,
		);
		return false;
	}

	return true;
}

function benchPass(side: Side, checkout: string): boolean {
	const files = passFiles(output, side);
	const criterionArgs = [
		"--output-format",
		"bencher",
		...(filter ? [filter] : []),
	];

	console.log(`::group::${side} pass`);
	// rust-cache restores Criterion's baselines with their sample files pruned.
	// Criterion errors comparing against one and drops that benchmark's bencher
	// line, which bench-gate then reads as a missing benchmark.
	rmSync(join(targetDir, "criterion"), { recursive: true, force: true });
	const workspace = join(checkout, "src-tauri");
	const passed =
		run({ command: ["mise", "install"], cwd: checkout }) &&
		run({
			command: [
				"mise",
				"exec",
				"--",
				"cargo",
				"clean",
				"--workspace",
				"--release",
			],
			cwd: workspace,
		}) &&
		run({
			command: [
				"mise",
				"exec",
				"--",
				"cargo",
				"bench",
				...BENCH_TARGETS,
				"--no-run",
				"--message-format",
				"json-render-diagnostics",
			],
			cwd: workspace,
			stdout: files.build,
		}) &&
		compiledItsOwnCrates(side, files.build) &&
		run({
			command: [
				"mise",
				"exec",
				"--",
				"cargo",
				"bench",
				...BENCH_TARGETS,
				"--",
				...criterionArgs,
			],
			cwd: workspace,
			stdout: files.raw,
		}) &&
		run({
			command: [
				"mise",
				"exec",
				"--",
				"bun",
				"run",
				"scripts/bench-gate.ts",
				files.raw,
			],
			cwd: checkout,
			stdout: files.normalized,
		});
	if (passed) {
		console.log(readFileSync(files.raw, "utf8"));
	}
	console.log("::endgroup::");

	return passed;
}

process.env.CARGO_TARGET_DIR = targetDir;
mkdirSync(output, { recursive: true });

const head = revParse("HEAD");
const base = chooseBase({
	before,
	beforeIsAncestor: isAncestor({ ancestor: before, descendant: head }),
	parent: revParse("HEAD^"),
});
const baseSha = revParse(base.sha);
console.log(`Base ${baseSha}: ${base.reason}. Head ${head}.`);

const scratch = mkdtempSync(join(tmpdir(), "bench-base-"));
let basePassed: boolean;
try {
	const baseCheckout = join(scratch, "trunk");
	basePassed =
		exportTree({
			sha: baseSha,
			archive: join(scratch, "base.tar"),
			checkout: baseCheckout,
		}) && benchPass("base", baseCheckout);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
const headPassed = benchPass("head", repository);

const outcome = outcomeOf({ base: baseSha, basePassed, headPassed });
if (outcome.kind === "fail") {
	console.error(`bench-ab: ${outcome.message}`);
	process.exit(1);
}

if (outcome.kind === "skip") {
	console.log(`::warning::${outcome.warning}`);
	process.exit(0);
}

process.exit(
	run({
		command: [process.execPath, "run", "scripts/bench-compare.ts", output],
		cwd: repository,
	})
		? 0
		: 1,
);
