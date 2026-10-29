#!/usr/bin/env bun
/**
 * The drive route end to end. Two drive instances run side by side, each on its
 * own copy of a fixture repository. Each shows the commits git lists, read back
 * through the socket alone. A commit typed into one and pressed through its
 * Commit button lands in that repository's git log, and leaves the other
 * instance's repository, prefs and review store byte-identical. A PNG of the
 * committing window shows the interface rather than a black frame. Neither
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
import { inflateSync } from "node:zlib";
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
	const committer = await launch(binary, committing, DEADLINE_MS);
	instances.push(committer);
	const watcher = await launch(binary, bystander, DEADLINE_MS);
	instances.push(watcher);

	const shown = (await commitRows(watcher, DEADLINE_MS)).sort();
	check(
		JSON.stringify(shown) === JSON.stringify(expected),
		`the graph shows ${shown.length} commits`,
		`expected ${JSON.stringify(expected)}\nshown    ${JSON.stringify(shown)}`,
	);
	await commitRows(committer, DEADLINE_MS);
	const before = fingerprint(bystander, join(watcher.dir, "data"));
	const ownBefore = fingerprint(join(committer.dir, "data"));

	await commitThroughTheForm(committer);

	const logged = gitLog(committing)[0];
	check(
		logged === SUMMARY,
		"the commit typed and pressed through the form is in git log",
		`git log's newest commit is "${logged}"`,
	);
	const changed = changedBetween(
		before,
		fingerprint(bystander, join(watcher.dir, "data")),
	);
	check(
		changed.length === 0,
		`the other instance's ${before.size} repository, prefs and review store files are unchanged`,
		`changed under the other instance: ${changed.join(", ")}`,
	);
	// Not a check: whether the committing instance wrote its own prefs or review
	// store says whether the line above could have caught a write to the wrong one.
	const own = changedBetween(
		ownBefore,
		fingerprint(join(committer.dir, "data")),
	);
	console.log(
		`info: the committing instance changed ${own.length} of its own data files${own.length ? `: ${own.join(", ")}` : ""}`,
	);

	await showsTheUi(committer);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	quitting = Date.now() / 1000;
	const quits = await Promise.allSettled(
		instances.map((instance) => request(instance, { op: "quit" }, DEADLINE_MS)),
	);
	activations.process.kill();
	for (const [i, quit] of quits.entries()) {
		if (quit.status === "fulfilled") continue;
		console.error(`${instances[i].dir} did not quit: ${quit.reason}`);
		process.exitCode = 1;
	}
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

/** Writes a PNG of the window and checks it shows the interface, which a
 *  black frame, the failure a capture without the Screen Recording grant
 *  gives, cannot: an interface with text draws many colours. */
async function showsTheUi(instance: Instance): Promise<void> {
	const path = join(instance.dir, "window.png");
	await request(instance, { op: "snapshot", path }, DEADLINE_MS);
	const colours = distinctColours(readFileSync(path));
	check(
		colours >= 16,
		`the snapshot shows the interface (${colours} colours)`,
		`the snapshot at ${path} has ${colours} colours, so it is not the interface`,
	);
}

/** The number of distinct colours in an 8-bit, non-interlaced RGB or RGBA PNG,
 *  the kind AppKit writes. */
function distinctColours(png: Buffer): number {
	let width = 0;
	let channels = 0;
	const data: Buffer[] = [];
	for (let at = 8; at < png.length; ) {
		const length = png.readUInt32BE(at);
		const type = png.toString("latin1", at + 4, at + 8);
		const body = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			const [depth, colour, , , interlace] = body.subarray(8, 13);
			channels = { 2: 3, 6: 4 }[colour] ?? 0;
			if (depth !== 8 || !channels || interlace !== 0) {
				throw new Error(
					`cannot read a PNG of depth ${depth}, colour ${colour}`,
				);
			}
		}
		if (type === "IDAT") data.push(body);
		at += 12 + length;
	}

	const raw = inflateSync(Buffer.concat(data));
	const stride = width * channels;
	const previous = Buffer.alloc(stride);
	const row = Buffer.alloc(stride);
	const colours = new Set<number>();
	for (let at = 0; at < raw.length; at += stride + 1) {
		const filter = raw[at];
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? row[x - channels] : 0;
			const b = previous[x];
			const c = x >= channels ? previous[x - channels] : 0;
			const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
			row[x] = (raw[at + 1 + x] + predicted) & 0xff;
		}
		for (let x = 0; x < stride; x += channels) {
			colours.add((row[x] << 16) | (row[x + 1] << 8) | row[x + 2]);
		}
		row.copy(previous);
	}
	return colours.size;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/** The paths whose hash differs between two fingerprints, or that only one has. */
function changedBetween(
	before: Map<string, string>,
	after: Map<string, string>,
): string[] {
	return [...new Set([...before.keys(), ...after.keys()])].filter(
		(path) => before.get(path) !== after.get(path),
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
