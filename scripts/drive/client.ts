/**
 * The agent's half of the drive route: it starts a drive instance of Trunk in
 * the background and sends it one request per connection over the instance's
 * socket (src-tauri/src/drive/mod.rs).
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const SOCKET = "drive.sock";
/** The instance renames this into place once its socket accepts connections. */
const LISTENING = "listening";
const TAB_ID = "drive-tab";

/** A request the instance names a failure for, carried back to the caller. */
export class DriveError extends Error {}

/** One running drive instance, addressed by the private directory it owns. */
export interface Instance {
	readonly dir: string;
}

export function instanceAt(dir: string): Instance {
	return { dir };
}

/**
 * Starts the drive binary on `repo` in its own directory, created 0700 by
 * mkdtemp, and resolves once its socket accepts connections. The instance's prefs and
 * review store live under that directory, so nothing the user's own Trunk
 * keeps is read or written.
 */
export async function launch(
	binary: string,
	repo: string,
	deadlineMs: number,
): Promise<Instance> {
	const dir = mkdtempSync(join(tmpdir(), "trunk-drive-"));
	const data = join(dir, "data");
	mkdirSync(data);
	writeFileSync(
		join(data, "trunk-prefs.json"),
		JSON.stringify({
			open_tabs: [{ id: TAB_ID, repoPath: repo, repoName: basename(repo) }],
			active_tab_id: TAB_ID,
		}),
	);

	const log = openSync(join(dir, "app.log"), "a");
	const child = spawn(binary, [], {
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, TRUNK_DRIVE_DIR: dir, TRUNK_DATA_DIR: data },
	});
	child.unref();

	await socketAppears(dir, child, deadlineMs);
	return instanceAt(dir);
}

/** Sends one request and resolves with the value the instance answered. */
export function request(
	instance: Instance,
	body: Record<string, unknown>,
	deadlineMs: number,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(join(instance.dir, SOCKET));
		// Decoding as one stream keeps a character split across chunks whole.
		socket.setEncoding("utf8");
		let received = "";

		socket.setTimeout(deadlineMs, () => {
			socket.destroy();
			reject(new DriveError(`no answer to ${body.op} in ${deadlineMs}ms`));
		});
		socket.on("error", reject);
		socket.on("data", (chunk) => {
			received += chunk;
		});
		socket.on("end", () => {
			if (received.trim() === "") {
				reject(
					new DriveError(
						`the instance closed the connection without answering ${body.op}`,
					),
				);
				return;
			}
			const reply = JSON.parse(received) as
				| { ok: true; value: unknown }
				| { ok: false; error: string };
			if (reply.ok) resolve(reply.value);
			else reject(new DriveError(reply.error));
		});
		socket.write(`${JSON.stringify(body)}\n`);
	});
}

/** Evaluates `expression` in the page and resolves with its awaited value. */
export function evaluate(
	instance: Instance,
	expression: string,
	deadlineMs: number,
): Promise<unknown> {
	return request(instance, { op: "eval", js: expression }, deadlineMs);
}

/**
 * Resolves with the first truthy value `expression` takes, re-reading it after
 * every change to the page's DOM, so a caller waits on a condition and never on
 * a duration.
 */
export function until(
	instance: Instance,
	expression: string,
	deadlineMs: number,
): Promise<unknown> {
	return callHook(instance, "until", [expression], deadlineMs);
}

/**
 * Calls one of the page's drive hooks (src/drive.ts) with string arguments. A
 * failure names the call, since an agent's script may make many.
 */
export async function callHook(
	instance: Instance,
	hook: keyof Window["__trunkDrive"],
	args: readonly string[],
	deadlineMs: number,
): Promise<unknown> {
	const call = args.map((arg) => JSON.stringify(arg)).join(", ");
	try {
		return await evaluate(
			instance,
			`window.__trunkDrive.${hook}(${call})`,
			deadlineMs,
		);
	} catch (error) {
		if (!(error instanceof DriveError)) throw error;
		throw new DriveError(`${hook}(${call}): ${error.message}`);
	}
}

/** Calls a Tauri command from the page, through the same IPC the UI uses. */
export function invoke(
	instance: Instance,
	command: string,
	args: unknown,
	deadlineMs: number,
): Promise<unknown> {
	return evaluate(
		instance,
		`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
		deadlineMs,
	);
}

/** Every commit summary the graph shows, once it shows at least one. */
export async function commitRows(
	instance: Instance,
	deadlineMs: number,
): Promise<string[]> {
	const rows = await until(
		instance,
		`(() => {
			const rows = [...document.querySelectorAll('[data-testid="commit-row-summary"]')]
				.map((cell) => cell.textContent.trim());
			return rows.length > 0 ? rows : null;
		})()`,
		deadlineMs,
	);
	return rows as string[];
}

function socketAppears(
	dir: string,
	child: ChildProcess,
	deadlineMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(dir);
		const timer = setTimeout(() => {
			finish(new DriveError(`no socket in ${dir} after ${deadlineMs}ms`));
		}, deadlineMs);
		const exited = (code: number | null) => {
			finish(
				new DriveError(`the instance exited with ${code}; see ${dir}/app.log`),
			);
		};

		function finish(error?: Error) {
			clearTimeout(timer);
			watcher.close();
			child.off("exit", exited);
			child.off("error", finish);
			if (!error) return resolve();
			// A detached instance that never announced itself would outlive the caller.
			child.kill();
			reject(error);
		}

		child.on("exit", exited);
		child.on("error", finish);
		watcher.on("change", (_event, name) => {
			if (name === LISTENING) finish();
		});
		if (existsSync(join(dir, LISTENING))) finish();
	});
}
