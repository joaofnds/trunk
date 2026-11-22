export const BODY_CLAMP_LINES = 10;

/** Explicit newlines give the initial count before the browser measures wrapping. */
export function bodyOverflows(
	body: string | null,
	renderedLines?: number,
): boolean {
	return (renderedLines ?? body?.split("\n").length ?? 0) > BODY_CLAMP_LINES;
}
