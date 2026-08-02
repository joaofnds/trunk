import { invoke } from "@tauri-apps/api/core";

// Tauri IPC errors arrive as raw strings, not Error objects.
// catch(e) { e.message } returns undefined — this wrapper fixes that.
export interface TrunkError {
	code: string;
	message: string;
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

export async function safeInvoke<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	try {
		return await invoke<T>(cmd, args);
	} catch (e: unknown) {
		throw asTrunkError(e);
	}
}

function asTrunkError(e: unknown): TrunkError {
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
