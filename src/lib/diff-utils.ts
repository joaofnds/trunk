import type { DiffLine } from "./types.js";

/**
 * Represents a paired row for split (side-by-side) diff display.
 * Context lines appear on both sides. Delete lines go to the left, Add lines to the right.
 * When one side has more lines, null entries (phantom rows) pad the shorter side.
 * Each entry carries the original lineIdx for correct staging callbacks.
 */
export interface PairedRow {
	left: { line: DiffLine; lineIdx: number } | null;
	right: { line: DiffLine; lineIdx: number } | null;
}

/**
 * Transforms a flat array of DiffLines into paired rows for split (side-by-side) display.
 * Context lines appear on both sides. Delete lines go to the left, Add lines to the right.
 * When one side has more lines, null entries (phantom rows) pad the shorter side.
 * Each entry carries the original lineIdx for correct staging callbacks.
 */
export function pairLines(lines: DiffLine[]): PairedRow[] {
	const rows: PairedRow[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (line.origin === "Context") {
			rows.push({
				left: { line, lineIdx: i },
				right: { line, lineIdx: i },
			});
			i++;
			continue;
		}

		// Collect consecutive deletes
		const deletes: { line: DiffLine; lineIdx: number }[] = [];
		while (i < lines.length && lines[i].origin === "Delete") {
			deletes.push({ line: lines[i], lineIdx: i });
			i++;
		}

		// Collect consecutive adds
		const adds: { line: DiffLine; lineIdx: number }[] = [];
		while (i < lines.length && lines[i].origin === "Add") {
			adds.push({ line: lines[i], lineIdx: i });
			i++;
		}

		// Pair them up, phantom rows fill the shorter side
		const maxLen = Math.max(deletes.length, adds.length);
		for (let j = 0; j < maxLen; j++) {
			rows.push({
				left: j < deletes.length ? deletes[j] : null,
				right: j < adds.length ? adds[j] : null,
			});
		}
	}

	return rows;
}

/**
 * Represents a segment of text for invisible character rendering.
 * When showInvisibles is active, space/tab characters are split into
 * separate segments. `text` is always the real characters (so it stays
 * selectable and copies faithfully); `glyph` is the presentation-only
 * substitution (·/→) the view paints via a pseudo-element. `glyph` is the
 * empty string for visible segments.
 */
export interface InvisibleSegment {
	text: string;
	glyph: string;
	isInvisible: boolean;
	isTrailing: boolean;
}

/**
 * Detects the index where trailing whitespace begins in a string.
 * Returns the string length if there is no trailing whitespace.
 */
export function trailingWhitespaceStart(text: string): number {
	let i = text.length;
	while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) {
		i--;
	}
	return i;
}

/**
 * Splits a text segment into invisible/visible sub-segments.
 * Invisible segments keep their real characters in `text` and carry the
 * presentation glyph (space -> middle dot U+00B7, tab -> rightwards arrow
 * U+2192) in `glyph`. Only spaces and tabs are handled -- no line ending markers.
 *
 * CRITICAL: This function must be called AFTER slicing line.content by span offsets.
 * Never call it before slicing -- that would break byte offset alignment.
 *
 * @param text - Already-sliced text segment
 * @param isTrailingRegion - Whether this segment falls within trailing whitespace
 */
export function splitInvisibles(
	text: string,
	isTrailingRegion: boolean,
): InvisibleSegment[] {
	if (!text) return [];

	const segments: InvisibleSegment[] = [];
	let current = "";
	let currentIsInvisible = false;

	function flush() {
		if (!current) return;
		segments.push({
			text: current,
			glyph: currentIsInvisible
				? current.replace(/ /g, "\u00B7").replace(/\t/g, "\u2192")
				: "",
			isInvisible: currentIsInvisible,
			isTrailing: currentIsInvisible && isTrailingRegion,
		});
		current = "";
	}

	for (const ch of text) {
		const invisible = ch === " " || ch === "\t";
		if (invisible !== currentIsInvisible) flush();
		current += ch;
		currentIsInvisible = invisible;
	}
	flush();

	return segments;
}
