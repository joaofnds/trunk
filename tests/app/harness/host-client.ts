import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** One `TestContextBuilder` verb, as the host protocol carries it. */
export type SpecStep =
	| { step: "file"; path: string; content: string }
	| { step: "commit"; message: string; at?: number };

export interface RepoSpec {
	steps: SpecStep[];
}

export type EventHandler = (event: string, payload: unknown) => void;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

const DEFAULT_HOST = "src-tauri/target/debug/examples/app_host";

/**
 * A spawned host process: the real Trunk application on `MockRuntime`, reached
 * over newline-delimited JSON. One client is one process is one test.
 */
export class HostClient {
	private readonly child: ChildProcess;
	private readonly pending = new Map<number, Pending>();
	private readonly handlers: EventHandler[] = [];
	private nextId = 1;
	private inFlight = 0;
	private lastStartedAt = 0;
	private stderr = "";
	private exited: string | null = null;

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

	/** When the most recent forwarded command started, on `performance.now()`'s clock. */
	get lastInvokeStartedAt(): number {
		return this.lastStartedAt;
	}

	onEvent(handler: EventHandler): void {
		this.handlers.push(handler);
	}

	async seedRepo(spec: RepoSpec): Promise<string> {
		return (await this.request({ verb: "seedRepo", spec })) as string;
	}

	async invoke<T>(cmd: string, args: unknown = {}): Promise<T> {
		this.inFlight += 1;
		this.lastStartedAt = performance.now();
		try {
			return (await this.request({ verb: "invoke", cmd, args })) as T;
		} finally {
			this.inFlight -= 1;
		}
	}

	async emit(event: string, payload: unknown): Promise<void> {
		await this.request({ verb: "emit", event, payload });
	}

	/** How many filesystem watches the application holds. Off means zero. */
	async watcherCount(): Promise<number> {
		return (await this.request({ verb: "watcherCount" })) as number;
	}

	/**
	 * Reaps the process and removes the tempdir `HOME`. A leaked host holds a
	 * tempdir open, so this runs even when the process is already gone.
	 */
	async shutdown(): Promise<void> {
		if (!this.exited) {
			await this.request({ verb: "shutdown" }).catch(() => {});
			await this.reaped();
		}
		this.child.kill("SIGKILL");
		rmSync(this.home, { recursive: true, force: true });
	}

	private request(body: Record<string, unknown>): Promise<unknown> {
		if (this.exited) {
			return Promise.reject(new Error(this.exited));
		}

		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.child.stdin?.write(`${JSON.stringify({ id, ...body })}\n`);
		});
	}

	private listen(): Promise<void> {
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});

		const lines = createInterface({ input: requireStream(this.child.stdout) });
		const ready = new Promise<void>((resolve, reject) => {
			lines.on("line", (line) => {
				if (this.dispatch(JSON.parse(line))) resolve();
			});
			this.child.on("exit", (code) => {
				this.exited = `the host exited with code ${code}\n${this.stderr}`;
				for (const [, waiter] of this.pending) {
					waiter.reject(new Error(this.exited));
				}
				this.pending.clear();
				reject(new Error(this.exited));
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

		if ("hostError" in message) {
			waiter.reject(new Error(message.hostError as string));
		} else if ("err" in message) {
			waiter.reject(message.err);
		} else {
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

/**
 * The host's environment is constructed, never inherited. `HOME` is a fresh
 * tempdir so `app_data_dir()` cannot reach the installed app's store; the editor
 * variables and the global git config are scrubbed exactly as `justfile:8` does
 * for the Rust suite, or the rebase editor-pin guards pass with the production
 * fix reverted; and `SHELL` is emptied so no host spawns `$SHELL -l -i -c`.
 */
function hostEnvironment(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		SHELL: "",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	delete env.GIT_EDITOR;
	delete env.EDITOR;
	delete env.VISUAL;
	return env;
}

function requireStream<T>(stream: T | null): T {
	if (!stream) throw new Error("the host was spawned without piped stdio");
	return stream;
}
