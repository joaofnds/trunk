/**
 * What the drive scenarios (smoke.ts, native.ts) share: reporting a check,
 * reading git, and logging which application is active from launch to quit.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";

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
export function activationLog(
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
export function activatedAmong(lines: string[], pids: string[]): string[] {
	return lines.filter((line) => pids.includes(line.split(" ")[1]));
}
