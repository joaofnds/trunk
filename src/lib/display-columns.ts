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

const TAB = 9;
const LEAD_SURROGATE_START = 0xd800;
const LEAD_SURROGATE_END = 0xdbff;
const TRAIL_SURROGATE_START = 0xdc00;
const TRAIL_SURROGATE_END = 0xdfff;

/** Columns the text occupies when laid out from column 0. */
export function displayColumns(
	text: string,
	tabSize: number,
	invisibles: boolean,
): number {
	let columns = 0;

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);

		if (code === TAB) {
			columns += invisibles ? 1 : tabSize - (columns % tabSize);
			continue;
		}
		if (code < 0x300) {
			columns++;
			continue;
		}

		columns += wideWidthAt(text, i);
		if (pairsWith(code, text.charCodeAt(i + 1))) i++;
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

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const pair = pairsWith(code, text.charCodeAt(i + 1));
		const width = widthOf(text, i, code, columns, tabSize, invisibles);
		if (columns + width > limit) return units;

		columns += width;
		units += pair ? 2 : 1;
		if (pair) i++;
	}

	return units;
}

/** The width rule, in one place. `displayColumns` inlines its fast path in the
 *  loop instead of calling this: over a 90,000-line file the extra read per
 *  character is measurable, and that pass runs on every rebuild. */
function widthOf(
	text: string,
	index: number,
	code: number,
	atColumn: number,
	tabSize: number,
	invisibles: boolean,
): number {
	if (code === TAB) {
		if (invisibles) return 1;
		return tabSize - (atColumn % tabSize);
	}
	if (code < 0x300) return 1;

	return wideWidthAt(text, index);
}

/** Only reached at or above U+0300, so the string allocation it costs is paid
 *  on the rare character rather than on every one. */
function wideWidthAt(text: string, index: number): number {
	const codePoint = text.codePointAt(index) ?? 0;
	if (COMBINING.test(String.fromCodePoint(codePoint))) return 0;

	return isWide(codePoint) ? 2 : 1;
}

/** True only for a well-formed pair: a lone lead surrogate is one unit. */
function pairsWith(code: number, next: number): boolean {
	return (
		code >= LEAD_SURROGATE_START &&
		code <= LEAD_SURROGATE_END &&
		next >= TRAIL_SURROGATE_START &&
		next <= TRAIL_SURROGATE_END
	);
}

function isWide(codePoint: number): boolean {
	for (const [start, end] of WIDE_RANGES) {
		if (codePoint < start) return false;
		if (codePoint <= end) return true;
	}

	return false;
}
