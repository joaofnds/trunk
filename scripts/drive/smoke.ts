#!/usr/bin/env bun
/**
 * The drive route end to end. Two drive instances run side by side, each on its
 * own copy of a fixture repository. Each shows the commits git lists, read back
 * through the socket alone. A commit typed into one and pressed through its
 * Commit button lands in that repository's git log, and leaves the other
 * instance's repository, prefs and review store byte-identical. Neither
 * instance ever becomes the active application, by the log the activation
 * logger (activations.swift) keeps from launch to quit. Run by
 * `just drive-smoke`.
 *
 * Usage: bun scripts/drive/smoke.ts <drive binary> <fixture repository> <activation logger>
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	callHook,
	commitRows,
	type Instance,
	launch,
	request,
	until,
} from "./client.js";

const DEADLINE_MS = 60_000;
const SUMMARY = "feat: commit typed through the drive route";

const [binary, fixture, logger] = process.argv.slice(2);
if (!binary || !fixture || !logger) {
	console.error(
		"usage: bun scripts/drive/smoke.ts <binary> <fixture> <logger>",
	);
	process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "trunk-drive-repos-"));
const committing = join(work, "committing");
const bystander = join(work, "bystander");
cpSync(fixture, committing, { recursive: true });
cpSync(fixture, bystander, { recursive: true });
writeFileSync(
	join(committing, "drive-note.txt"),
	"typed through the drive route\n",
);
const expected = gitLog(bystander).sort();

const activations = await activationLog(logger);
const launching = Date.now() / 1000;
let quitting = 0;
const instances: Instance[] = [];
try {
	const one = await launch(binary, committing, DEADLINE_MS);
	instances.push(one);
	const other = await launch(binary, bystander, DEADLINE_MS);
	instances.push(other);

	const shown = (await commitRows(other, DEADLINE_MS)).sort();
	check(
		JSON.stringify(shown) === JSON.stringify(expected),
		`the graph shows ${shown.length} commits`,
		`expected ${JSON.stringify(expected)}\nshown    ${JSON.stringify(shown)}`,
	);
	await commitRows(one, DEADLINE_MS);
	const before = fingerprint(bystander, join(other.dir, "data"));

	await commitThroughTheForm(one);

	const logged = gitLog(committing)[0];
	check(
		logged === SUMMARY,
		"the commit typed and pressed through the form is in git log",
		`git log's newest commit is "${logged}"`,
	);
	const after = fingerprint(bystander, join(other.dir, "data"));
	const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
		(path) => before.get(path) !== after.get(path),
	);
	check(
		changed.length === 0,
		`the other instance's ${before.size} repository, prefs and review store files are unchanged`,
		`changed under the other instance: ${changed.join(", ")}`,
	);
} finally {
	quitting = Date.now() / 1000;
	for (const instance of instances) {
		await request(instance, { op: "quit" }, DEADLINE_MS);
	}
	activations.process.kill();
}

const pids = instances.map((instance) =>
	readFileSync(join(instance.dir, "listening"), "utf8").trim(),
);
const activated = activations.lines.filter((line) =>
	pids.includes(line.split(" ")[1]),
);
check(
	activated.length === 0,
	`neither instance became active (${activations.lines.length - 1} other activations)`,
	`an instance (pids ${pids.join(", ")}) became active: ${activated.join("; ")}\nlaunched at ${launching}, quit sent at ${quitting}\n${activations.lines.join("\n")}`,
);

if (process.exitCode === 1) {
	console.error(
		`kept for inspection: ${work} and ${instances.map((i) => i.dir).join(", ")}`,
	);
} else {
	for (const instance of instances) {
		rmSync(instance.dir, { recursive: true, force: true });
	}
	rmSync(work, { recursive: true, force: true });
}

/** Stages the change, types the summary and presses Commit, as a user does,
 *  and returns once the graph shows the new commit. The working-tree row shows
 *  the typed summary as its draft, so only a row ending in a short sha is the
 *  commit. */
async function commitThroughTheForm(instance: Instance): Promise<void> {
	await callHook(
		instance,
		"click",
		["button", "Stage all changes"],
		DEADLINE_MS,
	);
	await until(
		instance,
		`window.__trunkDrive.list("button").includes("Staged Files 1") || null`,
		DEADLINE_MS,
	);
	await callHook(
		instance,
		"type",
		["textbox", "Summary (required)", SUMMARY],
		DEADLINE_MS,
	);
	await callHook(instance, "click", ["button", "Commit"], DEADLINE_MS);
	await until(
		instance,
		`window.__trunkDrive.list("option").some((name) => name.startsWith(${JSON.stringify(SUMMARY)}) && / [0-9a-f]{7}$/.test(name)) || null`,
		DEADLINE_MS,
	);
}

/** Every commit summary in the repository, newest first. */
function gitLog(repo: string): string[] {
	return execFileSync("git", ["log", "--all", "--format=%s"], {
		cwd: repo,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);
}

/** The sha256 of every file under the given directories, by path. */
function fingerprint(...dirs: string[]): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const dir of dirs) {
		for (const entry of readdirSync(dir, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (!entry.isFile()) continue;
			const path = join(entry.parentPath, entry.name);
			const hash = createHash("sha256").update(readFileSync(path));
			hashes.set(`${dir}:${relative(dir, path)}`, hash.digest("hex"));
		}
	}
	return hashes;
}

/** Prints the outcome and marks the run failed when `passed` is false, without
 *  exiting, so the instances are still quit. */
function check(passed: boolean, ok: string, failure: string): void {
	if (passed) {
		console.log(`ok: ${ok}`);
		return;
	}
	console.error(failure);
	process.exitCode = 1;
}

/** Starts the logger and resolves once it has printed its start line. */
function activationLog(
	path: string,
): Promise<{ process: ChildProcess; lines: string[] }> {
	return new Promise((resolve, reject) => {
		const child = spawn(path, [], { stdio: ["ignore", "pipe", "inherit"] });
		const lines: string[] = [];
		let pending = "";
		child.on("error", reject);
		child.stdout.on("data", (chunk) => {
			pending += chunk.toString("utf8");
			const complete = pending.split("\n");
			pending = complete.pop() ?? "";
			lines.push(...complete);
			if (lines.length === complete.length && lines.length > 0) {
				resolve({ process: child, lines });
			}
		});
	});
}
