// Refnames, paths, lock reasons and file names arrive from the repository, and git permits what
// looks unremarkable here: U+2028/U+2029 and the bidi overrides, which the native
// dialog lays out as hard breaks. Left in, a name adds its own lines to the question
// and can answer it.
const RENDER_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const MAX_REFNAME_CHARS = 60;
export const MAX_PATH_CHARS = 200;
export const MAX_MESSAGE_CHARS = 4000;

export function flattened(text: string): string {
	return text.replace(RENDER_UNSAFE, "�");
}

export function forDisplay(text: string, maxChars = MAX_REFNAME_CHARS): string {
	const shown = flattened(text);
	const points = Array.from(shown);
	return points.length <= maxChars
		? shown
		: `${points.slice(0, maxChars).join("")}…`;
}
