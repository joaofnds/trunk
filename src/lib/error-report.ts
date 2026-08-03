import { isTrunkError } from "./invoke.js";

export function errorMessage(e: unknown, fallback: string): string {
	if (e instanceof Error) return e.message;
	if (isTrunkError(e)) return e.message;
	if (typeof e === "string") return e;
	return fallback;
}
