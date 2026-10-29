/**
 * What the drive scenarios (smoke.ts, native.ts) share: running instances from
 * launch to quit under a log of which application is active, reporting a
 * check, and reading git.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Instance, launch, request } from "./client.js";

interface Run {
	/** The activation logger (activations.swift). */
	readonly logger: string;
	/** The scenario's own scratch directory, kept with the instances' when a
	 *  check fails. */
	readonly work: string;
	readonly deadlineMs: number;
}

/** Launches a drive instance that the scenario quits and checks at its end. */
export type Launch = (binary: string, repo: string) => Promise<Instance>;

/**
 * Runs `body`, then quits every instance it launched and checks that none
 * became the active application, by the log kept from before the first launch
 * to after the last quit. Removes the scratch directories when every check
 * passed, and keeps them for inspection otherwise.
 */
export async function driveScenario(
	{ logger, work, deadlineMs }: Run,
	body: (launch: Launch) => Promise<void>,
): Promise<void> {
	const activations = await activationLog(logger);
	const launching = Date.now() / 1000;
	let quitting = 0;
	const instances: Instance[] = [];
	try {
		await body(async (binary, repo) => {
			const instance = await launch(binary, repo, deadlineMs);
			instances.push(instance);
			return instance;
		});
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		quitting = Date.now() / 1000;
		const quits = await Promise.allSettled(
			instances.map((instance) =>
				request(instance, { op: "quit" }, deadlineMs),
			),
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
	const activated = activatedAmong(activations.lines, pids);
	check(
		instances.length > 0 && activated.length === 0,
		`none of the ${instances.length} instances became active (${activations.lines.length - 1} other activations)`,
		`of the instances launched (pids ${pids.join(", ")}), these became active: ${activated.join("; ")}\nlaunched at ${launching}, quit sent at ${quitting}\n${activations.lines.join("\n")}`,
	);

	if (process.exitCode === 1) {
		console.error(
			`kept for inspection: ${[work, ...instances.map((i) => i.dir)].join(", ")}`,
		);
		return;
	}
	for (const instance of instances) {
		rmSync(instance.dir, { recursive: true, force: true });
	}
	rmSync(work, { recursive: true, force: true });
}

/** Every commit summary in the repository, newest first. */
export function gitLog(repo: string): string[] {
	return execFileSync("git", ["log", "--all", "--format=%s"], {
		cwd: repo,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);
}

/** Prints the outcome and marks the run failed when `passed` is false, without
 *  exiting, so the instances are still quit. */
export function check(passed: boolean, ok: string, failure: string): void {
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

/** The logged activations of any of the processes `pids`, each line being the
 *  logger's time, then the pid of the application that became active. */
function activatedAmong(lines: string[], pids: string[]): string[] {
	return lines.filter((line) => pids.includes(line.split(" ")[1]));
}
