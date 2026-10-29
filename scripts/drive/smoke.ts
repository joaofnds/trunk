#!/usr/bin/env bun
/**
 * The drive route's walking skeleton, end to end: a drive instance started on a
 * copy of a fixture repository shows the commits git lists, read back through
 * the socket alone, and never becomes the active application, by the log the
 * activation logger (activations.swift) keeps from launch to quit. Run by
 * `just drive-smoke`.
 *
 * Usage: bun scripts/drive/smoke.ts <drive binary> <fixture repository> <activation logger>
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commitRows, launch, request } from "./client.js";

const DEADLINE_MS = 60_000;

const [binary, fixture, logger] = process.argv.slice(2);
if (!binary || !fixture || !logger) {
	console.error(
		"usage: bun scripts/drive/smoke.ts <binary> <fixture> <logger>",
	);
	process.exit(2);
}

const repo = join(mkdtempSync(join(tmpdir(), "trunk-drive-repo-")), "repo");
cpSync(fixture, repo, { recursive: true });
const expected = execFileSync("git", ["log", "--all", "--format=%s"], {
	cwd: repo,
	encoding: "utf8",
})
	.split("\n")
	.filter(Boolean)
	.sort();

const activations = await activationLog(logger);
const launching = Date.now() / 1000;
let quitting = 0;
const instance = await launch(binary, repo, DEADLINE_MS);
const pid = readFileSync(join(instance.dir, "listening"), "utf8").trim();
try {
	const shown = (await commitRows(instance, DEADLINE_MS)).sort();

	if (JSON.stringify(shown) !== JSON.stringify(expected)) {
		console.error(`expected ${JSON.stringify(expected)}`);
		console.error(`shown    ${JSON.stringify(shown)}`);
		console.error(`the instance's log is ${instance.dir}/app.log`);
		// process.exit here would skip the finally and leave the instance running.
		process.exitCode = 1;
	} else {
		console.log(`ok: the graph shows ${shown.length} commits`);
	}
} finally {
	quitting = Date.now() / 1000;
	await request(instance, { op: "quit" }, DEADLINE_MS);
	activations.process.kill();
}

const activated = activations.lines.filter(
	(line) => line.split(" ")[1] === pid,
);
if (activated.length > 0) {
	console.error(
		`the instance (pid ${pid}) became active: ${activated.join("; ")}`,
	);
	console.error(`launched at ${launching}, quit sent at ${quitting}`);
	console.error(activations.lines.join("\n"));
	process.exitCode = 1;
} else {
	console.log(
		`ok: the instance never became active (${activations.lines.length - 1} other activations)`,
	);
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

if (process.exitCode !== 1) {
	rmSync(instance.dir, { recursive: true, force: true });
	rmSync(dirname(repo), { recursive: true, force: true });
}
