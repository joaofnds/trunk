import { describe, expect, it } from "vitest";
import { findDiffMatches } from "./diff-find.js";
import type { DiffRow } from "./diff-rows.js";
import { pairLines } from "./diff-utils.js";
import type { DiffOrigin } from "./types.js";

function inline(
	content: string,
	origin: DiffOrigin = "Context",
): Extract<DiffRow, { kind: "line" }> {
	return {
		kind: "line",
		path: "file.ts",
		hunkIdx: 0,
		lineIdx: 0,
		flatIdx: 0,
		line: { content, origin, old_lineno: 1, new_lineno: 1, spans: [] },
		columns: content.length,
		marker: null,
	};
}

describe(findDiffMatches, () => {
	it("locates literal occurrences ignoring case in original UTF-16 offsets", () => {
		const rows = [inline("İx 🙂[Ö.] [ö.]")];

		const matches = findDiffMatches(rows, "[ö.]");

		expect(matches.length).toBe(2);
		expect(matches.at(0)).toEqual({ row: 0, side: "inline", start: 5, end: 9 });
		expect(matches.at(1)).toEqual({
			row: 0,
			side: "inline",
			start: 10,
			end: 14,
		});
	});

	it("orders split hits by row then side and visits shared context once", () => {
		const lines = [
			inline("hit").line,
			inline("hit hit", "Delete").line,
			inline("hit hit", "Add").line,
			inline("xhit", "Add").line,
			inline("hit").line,
			inline("hit", "Delete").line,
		];
		const rows: DiffRow[] = pairLines(lines).map((row) => ({
			kind: "pair",
			path: "file.ts",
			hunkIdx: 0,
			row,
			leftColumns: 0,
			rightColumns: 0,
			markerLeft: null,
			markerRight: null,
		}));

		const matches = findDiffMatches(rows, "HIT");

		expect(
			Array.from({ length: matches.length }, (_, i) => matches.at(i)),
		).toEqual([
			{ row: 0, side: "old", start: 0, end: 3 },
			{ row: 1, side: "old", start: 0, end: 3 },
			{ row: 1, side: "old", start: 4, end: 7 },
			{ row: 1, side: "new", start: 0, end: 3 },
			{ row: 1, side: "new", start: 4, end: 7 },
			{ row: 2, side: "new", start: 1, end: 4 },
			{ row: 3, side: "old", start: 0, end: 3 },
			{ row: 4, side: "old", start: 0, end: 3 },
		]);
	});

	it("skips headers, binary descriptions, and Git's missing-newline annotation", () => {
		const rows: DiffRow[] = [
			{ kind: "file-header", path: "needle", oldPath: null, collapsed: false },
			{ kind: "hunk-header", path: "file.ts", hunkIdx: 0, header: "needle" },
			{ kind: "binary", path: "file.ts", text: "needle" },
			inline("needle", "NoNewline"),
			inline("needle", "Delete"),
		];

		const matches = findDiffMatches(rows, "needle");

		expect(matches.length).toBe(1);
		expect(matches.at(0)).toEqual({ row: 4, side: "inline", start: 0, end: 6 });
	});

	it.each(["", "absent"])("returns no occurrences for query %j", (query) => {
		const matches = findDiffMatches([inline("source")], query);

		expect(matches.length).toBe(0);
		expect(matches.at(0)).toBeUndefined();
	});

	it("keeps a hit after a character that expands when lowercased at its source offset", () => {
		const matches = findDiffMatches([inline("İx")], "x");

		expect(matches.at(0)).toEqual({ row: 0, side: "inline", start: 1, end: 2 });
	});

	it("seeks in either direction across dense lines", () => {
		const rows = [inline("🙂x".repeat(512)), inline("x")];

		const matches = findDiffMatches(rows, "x");

		expect(matches.length).toBe(513);
		expect(matches.at(512)).toEqual({
			row: 1,
			side: "inline",
			start: 0,
			end: 1,
		});
		expect(matches.at(511)).toEqual({
			row: 0,
			side: "inline",
			start: 1535,
			end: 1536,
		});
		expect(matches.at(256)).toEqual({
			row: 0,
			side: "inline",
			start: 770,
			end: 771,
		});
		expect(matches.at(255)).toEqual({
			row: 0,
			side: "inline",
			start: 767,
			end: 768,
		});
	});
});
