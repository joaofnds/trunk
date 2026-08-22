/**
 * Column counting for fixed-pitch diff rows. A source character is not a
 * display column: a tab advances to the next stop under Tailwind's global
 * `tab-size: 4`, an East Asian wide character takes two cells, a combining mark
 * takes none, and an astral character is two UTF-16 units but one cell.
 *
 * `invisibles` mirrors the diff's show-invisibles toggle, which renders a tab
 * through `.invisible-char { font-size: 0 }` plus a `::before` glyph — one cell
 * rather than a tab stop.
 */

const COMBINING = /^[\p{Mn}\p{Me}]$/u;

/** East Asian Wide and Fullwidth code point ranges. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

/** Columns the text occupies when laid out from column 0. */
export function displayColumns(
	text: string,
	tabSize: number,
	invisibles: boolean,
): number {
	let columns = 0;

	for (const char of text) {
		columns += advance(char, columns, tabSize, invisibles);
	}

	return columns;
}

/** UTF-16 length of the longest prefix fitting in `limit` columns — what a wrap
 *  point needs. Never splits a surrogate pair, and never leaves a combining
 *  mark behind its base. */
export function columnsUpTo(
	text: string,
	limit: number,
	tabSize: number,
	invisibles: boolean,
): number {
	let columns = 0;
	let units = 0;

	for (const char of text) {
		const width = advance(char, columns, tabSize, invisibles);
		if (columns + width > limit) return units;

		columns += width;
		units += char.length;
	}

	return units;
}

function advance(
	char: string,
	atColumn: number,
	tabSize: number,
	invisibles: boolean,
): number {
	if (char === "\t") {
		if (invisibles) return 1;
		return tabSize - (atColumn % tabSize);
	}

	return charColumns(char);
}

function charColumns(char: string): number {
	const codePoint = char.codePointAt(0) ?? 0;
	if (codePoint < 0x300) return 1;

	if (COMBINING.test(char)) return 0;

	return isWide(codePoint) ? 2 : 1;
}

function isWide(codePoint: number): boolean {
	for (const [start, end] of WIDE_RANGES) {
		if (codePoint < start) return false;
		if (codePoint <= end) return true;
	}

	return false;
}
