import { describe, expect, it } from "vitest";
import { columnsUpTo, displayColumns } from "./display-columns.js";

describe("displayColumns", () => {
	it.each([
		["\t", 4],
		["abcde\t", 8],
	])(
		"advances %j to the next tab stop, reaching column %i",
		(text, columns) => {
			expect(displayColumns(text, 4, false)).toBe(columns);
		},
	);

	it("counts a tab as one cell when invisibles are shown", () => {
		expect(displayColumns("\t", 4, true)).toBe(1);
	});

	it("counts an East Asian wide character as two columns", () => {
		expect(displayColumns("漢字", 4, false)).toBe(4);
	});

	it("counts a combining mark as no columns of its own", () => {
		expect(displayColumns("e\u0301", 4, false)).toBe(1);
	});

	it("counts an astral character once rather than per UTF-16 unit", () => {
		expect(displayColumns("\u{1D400}", 4, false)).toBe(1);
	});
});

describe("columnsUpTo", () => {
	it("fits the whole string when the limit is its own column count", () => {
		const text = "\tconst x = 1;";

		const units = columnsUpTo(text, displayColumns(text, 4, false), 4, false);

		expect(units).toBe(text.length);
	});

	it("stops before the character that would overflow the limit", () => {
		expect(columnsUpTo("abcdef", 4, 4, false)).toBe(4);
	});

	it("keeps an astral character whole rather than splitting its surrogates", () => {
		expect(columnsUpTo("a\u{1D400}", 1, 4, false)).toBe(1);
	});

	it("counts a wide character only when both its columns fit", () => {
		expect(columnsUpTo("a漢", 2, 4, false)).toBe(1);
	});
});
