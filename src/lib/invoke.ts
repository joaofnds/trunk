import { invoke } from "@tauri-apps/api/core";
import { span } from "./perf.js";
import type { Scheduler } from "./scheduler.js";
import { isUpdateFrozen } from "./updates-lifecycle.js";

const pendingInvokes = new Set<Promise<unknown>>();
const UPDATE_FLUSH_COMMANDS = new Set([
	"prefs_get",
	"prefs_set",
	"save_draft",
	"get_draft",
	"delete_draft",
]);

/** Resolve once no call is pending and the callers of the last ones have
 *  moved on, so a call their continuation makes is waited for too. */
export async function invokesSettled(scheduler: Scheduler): Promise<void> {
	for (;;) {
		await Promise.allSettled(pendingInvokes);
		await new Promise<void>((resolve) => scheduler.setTimeout(resolve, 0));
		if (pendingInvokes.size === 0) return;
	}
}

function isUpdateCommand(cmd: string): boolean {
	return cmd.startsWith("updates_");
}

// Tauri IPC errors arrive as raw strings, not Error objects.
// catch(e) { e.message } returns undefined — this wrapper fixes that.
export interface TrunkError {
	code: string;
	message: string;
	/** The stash entry a failed pull kept of the changes it started with. */
	pull_safety_copy?: string;
}

// Type guard for the TrunkError shape thrown by safeInvoke (a plain object with
// string `code` + `message`, NOT an Error subclass). Used in catch blocks to
// surface `.message` and branch on `.code` without an unchecked `as` cast.
export function isTrunkError(e: unknown): e is TrunkError {
	return (
		typeof e === "object" &&
		e !== null &&
		"code" in e &&
		"message" in e &&
		typeof (e as { code: unknown }).code === "string" &&
		typeof (e as { message: unknown }).message === "string"
	);
}

// Every frontend->backend operation goes through here, so timing this one
// function covers all of them without touching a call site.
export async function safeInvoke<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	if (
		isUpdateFrozen() &&
		!isUpdateCommand(cmd) &&
		!(
			UPDATE_FLUSH_COMMANDS.has(cmd) && typeof args?.__updatePermit === "string"
		)
	) {
		throw {
			code: "update_preparing",
			message:
				"Trunk is preparing to restart. Try again when preparation finishes.",
		} satisfies TrunkError;
	}

	const pending = span(`invoke:${cmd}`, async () => {
		try {
			return await invoke<T>(cmd, args);
		} catch (e: unknown) {
			throw asTrunkError(e);
		}
	});
	if (isUpdateCommand(cmd)) return pending;

	pendingInvokes.add(pending);
	try {
		return await pending;
	} finally {
		pendingInvokes.delete(pending);
	}
}

function asTrunkError(e: unknown): TrunkError {
	if (isTrunkError(e)) return e;
	if (typeof e !== "string") {
		return { code: "unknown_error", message: "An unexpected error occurred" };
	}

	return parseTrunkError(e) ?? { code: "unknown_error", message: e };
}

function parseTrunkError(payload: string): TrunkError | null {
	try {
		const parsed: unknown = JSON.parse(payload);
		return isTrunkError(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
