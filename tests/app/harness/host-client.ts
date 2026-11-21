import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { descendantsOf } from "./processes.js";

/** One `TestContextBuilder` verb, as the host protocol carries it. */
export type SpecStep =
	| { step: "file"; path: string; content: string }
	| { step: "removeFile"; path: string }
	| { step: "commit"; message: string; at?: number }
	| { step: "branch"; name: string }
	| { step: "tag"; name: string }
	| { step: "checkout"; name: string }
	| { step: "merge"; branch: string }
	| { step: "remote"; name: string }
	| { step: "trackUpstream"; remote: string; branch: string }
	| { step: "push"; remote: string; branch: string }
	| {
			step: "remoteCommit";
			remote: string;
			branch: string;
			path: string;
			content: string;
			message: string;
	  }
	| { step: "worktree"; name: string; branch: string }
	| { step: "worktreeFile"; worktree: string; path: string; content: string };

export interface RepoSpec {
	steps: SpecStep[];
}

export type EventHandler = (event: string, payload: unknown) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	/** Runs on the reply line itself, ahead of any line read behind it. */
	onReply?: (value: unknown) => void;
	/** What the host was asked to do, and when, so a wait that expires can say
	 *  which round trip never came back. */
	label: string;
	startedAt: number;
	stallTimer: NodeJS.Timeout;
}

const DEFAULT_HOST = "src-tauri/target/debug/examples/app_host";
const DEFAULT_CLI = "src-tauri/target/debug/trunk";

/**
 * A healthy round trip takes milliseconds and a default wait expires at 5 s, so
 * a host still silent at 4 s is sampled while it is stuck. A hook timeout never
 * reaches the wait's diagnostics, and this is the only record it leaves
 * (TRUNK-413).
 */
const SAMPLE_STALLED_HOST_AFTER_MS = 4_000;

/**
 * Starves a chosen host command, so a wait that only fails on a loaded machine
 * can be made to fail on demand. Seeing a test fail for the reason claimed is
 * the only thing that makes a fix for it trustworthy (TRUNK-62), and these three
 * waits could previously be reproduced only by loading the whole machine.
 *
 * `TRUNK_HOST_STALL_MS` sets the delay; `TRUNK_HOST_STALL_CMD` narrows it to the
 * commands whose name contains that substring, defaulting to all of them. Both
 * are unset in the gate. A stall is paid per command, so a wait costing several
 * round trips pays it several times over.
 */
const STALL_MS = Number(process.env.TRUNK_HOST_STALL_MS ?? "0");
const STALL_CMD = process.env.TRUNK_HOST_STALL_CMD ?? "";

function stalls(cmd: string): boolean {
	return STALL_MS > 0 && cmd.includes(STALL_CMD);
}

function stall(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A spawned host process: the real Trunk application on `MockRuntime`, reached
 * over newline-delimited JSON. One client is one process is one test.
 */
export class HostClient {
	private readonly child: ChildProcess;
	private readonly pending = new Map<number, Pending>();
	/** Commands `invoke` has entered and not yet returned from, which spans the
	 *  stall knob's delay as well as the round trip itself. */
	private readonly entered = new Set<{ cmd: string; startedAt: number }>();
	private readonly handlers: EventHandler[] = [];
	private readonly cliRuns = new AbortController();
	private nextId = 1;
	private inFlight = 0;
	private stderr = "";
	private exited: string | null = null;
	private closing = false;
	private sampled = false;

	/** Invariant 7: a crashed test that skips `teardown` must not leave a host
	 *  process holding a tempdir. */
	private readonly reap = () => {
		this.child.kill("SIGKILL");
		rmSync(this.home, { recursive: true, force: true });
	};

	private constructor(
		child: ChildProcess,
		readonly home: string,
	) {
		this.child = child;
	}

	static async spawn(): Promise<HostClient> {
		const home = mkdtempSync(join(tmpdir(), "trunk-app-host-"));
		const child = spawn(hostBinary(), [], {
			env: hostEnvironment(home),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = new HostClient(child, home);

		await client.listen();
		return client;
	}

	/** Every command the client has forwarded and not yet heard back about. */
	get pendingInvokes(): number {
		return this.inFlight;
	}

	/**
	 * What the host was still owed at this instant, and what it printed.
	 *
	 * A wait that expires can otherwise say only that the DOM never changed,
	 * which is why TRUNK-62 sat parked: nobody had ever seen *why* a round trip
	 * failed to return. An outstanding command with an age says the host is slow
	 * or stuck; nothing outstanding says the host answered and the frontend did
	 * not act on it. Those want different fixes, and this is what tells them
	 * apart. Never throws, because it runs on a path that is already failing.
	 */
	describeOutstanding(): string {
		const now = Date.now();
		const invokes = [...this.entered].map(
			({ cmd, startedAt }) =>
				`  invoke ${cmd}, outstanding ${now - startedAt}ms`,
		);
		const requests = [...this.pending.entries()].map(
			([id, { label, startedAt }]) =>
				`  request #${id} ${label}, outstanding ${now - startedAt}ms`,
		);
		const waiting = [...invokes, ...requests];
		const commands = waiting.length
			? `${waiting.length} host command(s) outstanding:\n${waiting.join("\n")}`
			: "no host command outstanding: the host answered everything it was asked";

		return [
			commands,
			this.exited ? `host exited: ${this.exited}` : "host is running",
			`host stderr: ${this.stderr.trim() || "(empty)"}`,
		].join("\n");
	}

	onEvent(handler: EventHandler): void {
		this.handlers.push(handler);
	}

	async seedRepo(spec: RepoSpec): Promise<string> {
		return (await this.request({ verb: "seedRepo", spec })) as string;
	}

	async invoke<T>(
		cmd: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		this.inFlight += 1;
		// Recorded before the stall, so a command the knob is deliberately
		// starving reads as outstanding rather than as one the host answered.
		const entry = { cmd, startedAt: Date.now() };
		this.entered.add(entry);
		try {
			if (stalls(cmd)) await stall(STALL_MS);
			return (await this.request(
				{ verb: "invoke", cmd, args },
				onReply as ((value: unknown) => void) | undefined,
			)) as T;
		} finally {
			this.entered.delete(entry);
			this.inFlight -= 1;
		}
	}

	async emit(event: string, payload: unknown): Promise<void> {
		await this.request({ verb: "emit", event, payload });
	}

	/**
	 * Runs the `trunk` CLI the way an agent does, in this host's environment, so
	 * it writes the review store the host reads. Resolves to what it printed and
	 * rejects when it exits non-zero, or when the host shuts down before it exits.
	 * `onOutput` sees what it prints as it prints it, for a verb that never exits.
	 */
	cli(args: string[], onOutput?: (chunk: string) => void): Promise<string> {
		if (this.closing)
			return Promise.reject(
				new Error(`trunk ${args.join(" ")}: host shut down`),
			);

		return new Promise((resolve, reject) => {
			const run = execFile(
				cliBinary(),
				args,
				{
					env: hostEnvironment(this.home),
					signal: this.cliRuns.signal,
					killSignal: "SIGKILL",
				},
				(error, stdout, stderr) => {
					if (error)
						reject(
							new Error(`trunk ${args.join(" ")}: ${stderr || error.message}`, {
								cause: error,
							}),
						);
					else resolve(stdout);
				},
			);
			if (onOutput) run.stdout?.on("data", (chunk) => onOutput(String(chunk)));
		});
	}

	/** The watcher's report of a change to `paths`, relative to `repo`, made
	 *  through the function the watcher itself calls. No paths reports the
	 *  unscoped form. */
	async worktreeChange(repo: string, paths: string[]): Promise<void> {
		await this.request({ verb: "worktreeChange", repo, paths });
	}

	/** How many filesystem watches the application holds. Off means zero. */
	async watcherCount(): Promise<number> {
		return (await this.request({ verb: "watcherCount" })) as number;
	}

	/**
	 * Ends every CLI run still going, reaps the process and removes the tempdir
	 * `HOME`. A leaked host holds a tempdir open, so this runs even when the
	 * process is already gone. A test that times out never sees its CLI exit,
	 * and nothing else would end a `trunk review watch` or a hung run.
	 */
	async shutdown(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.cliRuns.abort();

		if (!this.exited) {
			this.send({ id: this.nextId++, verb: "shutdown" });
			await this.reaped();
		}
		this.child.kill("SIGKILL");
		process.off("exit", this.reap);
		rmSync(this.home, { recursive: true, force: true });
	}

	/**
	 * Unmounting the application destroys effects, and their `plugin:event|unlisten`
	 * calls land in microtasks after `teardown` has moved on. A closing client has
	 * nothing left to unregister, so those resolve quietly rather than writing down
	 * a pipe nobody is reading.
	 */
	private request(
		body: Record<string, unknown>,
		onReply?: (value: unknown) => void,
	): Promise<unknown> {
		if (this.closing || this.exited) return Promise.resolve(null);

		const id = this.nextId++;
		const label = String(body.cmd ?? body.verb);
		const startedAt = Date.now();
		return new Promise((resolve, reject) => {
			const stallTimer = this.sampleIfStalled(`request #${id} ${label}`);
			this.pending.set(id, {
				resolve,
				reject,
				onReply,
				label,
				startedAt,
				stallTimer,
			});
			this.send({ id, ...body });
		});
	}

	private sampleIfStalled(waitingOn: string): NodeJS.Timeout {
		const timer = setTimeout(
			() => this.sampleStall(waitingOn),
			SAMPLE_STALLED_HOST_AFTER_MS,
		);
		timer.unref();
		return timer;
	}

	private sampleStall(waitingOn: string): void {
		const pid = this.child.pid;
		if (this.sampled || this.closing || this.exited || pid === undefined)
			return;
		this.sampled = true;

		const path = join(tmpdir(), `trunk-app-host-stall-${pid}.txt`);
		const table = ["-A", "-o", "pid=,ppid=,etime=,time=,command="];
		execFile("ps", table, (_, processes) => {
			const children = descendantsOf(processes ?? "", pid);
			const started = children.length
				? `processes the host started, still running (pid ppid elapsed cpu command):\n${children.map((line) => `  ${line}`).join("\n")}`
				: "no process the host started is still running";
			// The log is all CI keeps of a run, so what the host is waiting on goes
			// there, and only the stacks stay in the file.
			process.stderr.write(
				`app host ${pid} has not answered ${waitingOn} in ${SAMPLE_STALLED_HOST_AFTER_MS}ms; ${started}\nsampling it into ${path} (TRUNK-413, TRUNK-500)\n`,
			);
			execFile("sample", [String(pid), "1", "-file", path], () => {
				try {
					appendFileSync(path, `\n${started}\n${this.describeOutstanding()}\n`);
				} catch {}
			});
		});
	}

	private send(line: Record<string, unknown>): void {
		this.child.stdin?.write(`${JSON.stringify(line)}\n`);
	}

	private listen(): Promise<void> {
		process.on("exit", this.reap);
		this.child.stdin?.on("error", () => {});
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});

		const lines = createInterface({ input: requireStream(this.child.stdout) });
		const startup = this.sampleIfStalled("startup, before its ready line");
		const ready = new Promise<void>((resolve, reject) => {
			lines.on("line", (line) => {
				if (this.dispatch(JSON.parse(line))) {
					clearTimeout(startup);
					resolve();
				}
			});
			this.child.on("exit", (code, signal) => {
				clearTimeout(startup);
				this.exited = `the host exited with code ${code}, signal ${signal}\n${this.stderr}`;
				const failure = new Error(this.exited);
				for (const [, waiter] of this.pending) {
					clearTimeout(waiter.stallTimer);
					if (this.closing) waiter.resolve(null);
					else waiter.reject(failure);
				}
				this.pending.clear();
				reject(failure);
			});
		});

		return ready;
	}

	/** Returns true for the `ready` line, which is what `spawn` waits on. */
	private dispatch(message: Record<string, unknown>): boolean {
		if (message.ready === true) return true;

		if (message.push === "event") {
			const payload = JSON.parse(message.payload as string) as unknown;
			for (const handler of this.handlers) {
				handler(message.event as string, payload);
			}
			return false;
		}

		const waiter = this.pending.get(message.id as number);
		if (!waiter) return false;
		this.pending.delete(message.id as number);
		clearTimeout(waiter.stallTimer);
		const took = Date.now() - waiter.startedAt;
		// A stall report says the host had not answered yet. This says when it did,
		// so a slow test's time divides into the host's part and the page's.
		if (took >= SAMPLE_STALLED_HOST_AFTER_MS) {
			process.stderr.write(
				`app host ${this.child.pid} answered request #${message.id} ${waiter.label} after ${took}ms (TRUNK-500)\n`,
			);
		}

		if ("hostError" in message) {
			waiter.reject(new Error(message.hostError as string));
		} else if ("err" in message) {
			waiter.reject(message.err);
		} else {
			waiter.onReply?.(message.ok);
			waiter.resolve(message.ok);
		}
		return false;
	}

	private reaped(): Promise<void> {
		if (this.exited) return Promise.resolve();
		return new Promise((resolve) => this.child.once("exit", () => resolve()));
	}
}

function hostBinary(): string {
	return process.env.TRUNK_APP_HOST ?? join(process.cwd(), DEFAULT_HOST);
}

function cliBinary(): string {
	return process.env.TRUNK_CLI ?? join(process.cwd(), DEFAULT_CLI);
}

/**
 * The host's environment is constructed, never inherited. `HOME` is a fresh
 * tempdir, and `XDG_DATA_HOME` is dropped so Linux resolves under it too, so
 * `app_data_dir()` cannot reach the installed app's store. `TRUNK_DATA_DIR`
 * names the review store inside it for the host and the CLI alike, so neither
 * follows one exported in the shell, and a `target/debug/trunk` last built by a
 * dev-config recipe (`just dev`, `dev-app`), which derives the dev identifier,
 * still writes the store the host reads. The editor
 * variables and the global git config are scrubbed exactly as `justfile:8` does
 * for the Rust suite, or the rebase editor-pin guards pass with the production
 * fix reverted; and `SHELL` is emptied so no host spawns `$SHELL -l -i -c`.
 */
function hostEnvironment(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		TRUNK_DATA_DIR: join(home, "review-store"),
		SHELL: "",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	delete env.XDG_DATA_HOME;
	delete env.GIT_EDITOR;
	delete env.EDITOR;
	delete env.VISUAL;
	return env;
}

function requireStream<T>(stream: T | null): T {
	if (!stream) throw new Error("the host was spawned without piped stdio");
	return stream;
}
