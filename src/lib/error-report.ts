import { message } from "@tauri-apps/plugin-dialog";
import { isTrunkError } from "./invoke.js";
import { showToast } from "./toast.svelte.js";

export function errorMessage(e: unknown, fallback: string): string {
	if (e instanceof Error) return e.message;
	if (isTrunkError(e)) return e.message;
	if (typeof e === "string") return e;
	return fallback;
}

export function reportErrorToast(e: unknown, fallback: string): void {
	showToast(errorMessage(e, fallback), "error");
}

export async function reportErrorDialog(
	e: unknown,
	title: string,
	fallback: string,
): Promise<void> {
	await message(errorMessage(e, fallback), { title, kind: "error" });
}
