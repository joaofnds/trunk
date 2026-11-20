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
