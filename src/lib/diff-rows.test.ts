import { describe, expect, it } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	type BuildOptions,
	buildInlineRows,
	buildSplitRows,
	FIXED_ROW_HEIGHTS,
	rowHeights,
	rowIndexForLine,
} from "./diff-rows.js";
import { displayColumns } from "./display-columns.js";
import type {
	DiffHunk,
	DiffLine,
	DiffOrigin,
	FileDiff,
	Side,
	Thread,
} from "./types.js";

function line(
	origin: DiffOrigin,
	content: string,
	oldNo: number | null,
	newNo: number | null,
): DiffLine {
	return {
		origin,
		content,
		old_lineno: oldNo,
		new_lineno: newNo,
		spans: [],
	};
}

function hunk(header: string, lines: DiffLine[]): DiffHunk {
	return {
		header,
		old_start: 1,
		old_lines: lines.length,
		new_start: 1,
		new_lines: lines.length,
		lines,
	};
}

function file(path: string, hunks: DiffHunk[], isBinary = false): FileDiff {
	return {
		path,
		old_path: null,
		status: "Modified",
		is_binary: isBinary,
		hunks,
	};
}

function thread(
	id: string,
	side: Side,
	startLine: number,
	endLine: number,
): Thread {
	return aThread({
		id,
		review_id: "review-1",
		text: id,
		anchor: {
			commit_oid: "oid",
			file_path: "src/main.ts",
			source: "FullFile",
			side,
			start_line: startLine,
			end_line: endLine,
		},
	});
}

const fullMode: BuildOptions = {
	content: "full",
	comments: [],
	showInlineComments: true,
	collapsed: new Set(),
	fileHeaders: false,
	tabSize: 4,
	invisibles: false,
};

const twoHunks = file("src/main.ts", [
	hunk("@@ -1,2 +1,2 @@", [
		line("Context", "first", 1, 1),
		line("Add", "second", null, 2),
	]),
	hunk("@@ -9,1 +9,1 @@", [line("Context", "third", 9, 9)]),
]);

describe("buildInlineRows", () => {
	it("flattens every hunk's lines into one row per line in full mode", () => {
		const model = buildInlineRows([twoHunks], fullMode);

		expect(model.rows.map((row) => row.kind)).toEqual(["line", "line", "line"]);
	});

	it("carries the hunk index, the in-hunk line index and the flat index", () => {
		const model = buildInlineRows([twoHunks], fullMode);

		const indices = model.rows.map((row) =>
			row.kind === "line" ? [row.hunkIdx, row.lineIdx, row.flatIdx] : null,
		);

		expect(indices).toEqual([
			[0, 0, 0],
			[0, 1, 1],
			[1, 0, 2],
		]);
	});

	it("precedes each hunk's lines with a header row in hunk mode", () => {
		const model = buildInlineRows([twoHunks], { ...fullMode, content: "hunk" });

		expect(model.rows.map((row) => row.kind)).toEqual([
			"hunk-header",
			"line",
			"line",
			"hunk-header",
			"line",
		]);
	});

	it("emits a comment row directly after the line its thread anchors to", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			comments: [thread("t1", "New", 2, 2)],
		});

		expect(model.rows.map((row) => row.kind)).toEqual([
			"line",
			"line",
			"comment",
			"line",
		]);
	});

	it("holds every thread anchored to the same line in one comment row", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			comments: [thread("t1", "New", 2, 2), thread("t2", "New", 2, 2)],
		});

		const comment = model.rows.find((row) => row.kind === "comment");

		expect(
			comment?.kind === "comment" && comment.threads.map((t) => t.id),
		).toEqual(["t1", "t2"]);
	});

	it("anchors the comment row to its line's indices", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			comments: [thread("t1", "New", 2, 2)],
		});

		const comment = model.rows.find((row) => row.kind === "comment");

		expect(
			comment?.kind === "comment" && [
				comment.hunkIdx,
				comment.lineIdx,
				comment.flatIdx,
			],
		).toEqual([0, 1, 1]);
	});

	it("omits comment rows when inline comments are hidden", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			showInlineComments: false,
			comments: [thread("t1", "New", 2, 2)],
		});

		expect(model.rows.some((row) => row.kind === "comment")).toBe(false);
	});

	it("marks a line spanned when a comment's range covers it", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			comments: [thread("t1", "New", 1, 2)],
		});

		const spanned = model.rows
			.filter((row) => row.kind === "line")
			.map((row) => row.spanned);

		expect(spanned).toEqual([true, true, false]);
	});

	it("leaves lines unspanned when inline comments are hidden", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			showInlineComments: false,
			comments: [thread("t1", "New", 1, 2)],
		});

		expect(model.rows.every((row) => row.kind !== "line" || !row.spanned)).toBe(
			true,
		);
	});

	it("emits a header row and a binary row, and no line rows, for a binary file", () => {
		const binary = file("assets/logo.png", [], true);

		const model = buildInlineRows([binary], { ...fullMode, fileHeaders: true });

		expect(model.rows.map((row) => row.kind)).toEqual([
			"file-header",
			"binary",
		]);
	});

	it("emits only the header row for a collapsed file", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			fileHeaders: true,
			collapsed: new Set(["src/main.ts"]),
		});

		expect(model.rows.map((row) => row.kind)).toEqual(["file-header"]);
	});

	it("marks the header row of a collapsed file collapsed", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			fileHeaders: true,
			collapsed: new Set(["src/main.ts"]),
		});

		const header = model.rows[0];

		expect(header.kind === "file-header" && header.collapsed).toBe(true);
	});

	it("omits the header row for a view that shows no file header", () => {
		const model = buildInlineRows([twoHunks], fullMode);

		expect(model.rows.some((row) => row.kind === "file-header")).toBe(false);
	});

	it("restarts the flat index at each file", () => {
		const second = file("src/other.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "only", 1, 1)]),
		]);

		const model = buildInlineRows([twoHunks, second], fullMode);

		const flat = model.rows
			.filter((row) => row.kind === "line")
			.map((row) => row.flatIdx);

		expect(flat).toEqual([0, 1, 2, 0]);
	});

	it("reports the widest line's display columns", () => {
		const wide = file("src/main.ts", [
			hunk("@@ -1,2 +1,2 @@", [
				line("Context", "short", 1, 1),
				line("Context", "a much longer line", 2, 2),
			]),
		]);

		const model = buildInlineRows([wide], fullMode);

		expect(model.columns).toEqual(["a much longer line".length]);
	});

	it("counts a tab to its stop when measuring the widest line", () => {
		const tabbed = file("src/main.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "\tx", 1, 1)]),
		]);

		const model = buildInlineRows([tabbed], fullMode);

		expect(model.columns).toEqual([5]);
	});

	it("counts a tab as one cell for the widest line when invisibles are shown", () => {
		const tabbed = file("src/main.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "\tx", 1, 1)]),
		]);

		const model = buildInlineRows([tabbed], { ...fullMode, invisibles: true });

		expect(model.columns).toEqual([2]);
	});

	it("sizes the gutter to the largest line number's digits plus one", () => {
		const deep = file("src/main.ts", [
			hunk("@@ -998,1 +1000,1 @@", [line("Context", "x", 998, 1000)]),
		]);

		const model = buildInlineRows([deep], fullMode);

		expect(model.gutterChars).toBe(5);
	});

	it("sizes the gutter for a file with no lines at all", () => {
		const model = buildInlineRows(
			[file("assets/logo.png", [], true)],
			fullMode,
		);

		expect(model.gutterChars).toBe(2);
	});

	it("lists every hunk once in document order, carrying its file path", () => {
		const second = file("src/other.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "only", 1, 1)]),
		]);

		const model = buildInlineRows([twoHunks, second], {
			...fullMode,
			content: "hunk",
		});

		expect(model.hunkNav.map((nav) => [nav.path, nav.hunkIdx])).toEqual([
			["src/main.ts", 0],
			["src/main.ts", 1],
			["src/other.ts", 0],
		]);
	});

	it("points each hunk at its header row in hunk mode", () => {
		const model = buildInlineRows([twoHunks], { ...fullMode, content: "hunk" });

		const kinds = model.hunkNav.map((nav) => model.rows[nav.rowIndex].kind);

		expect(kinds).toEqual(["hunk-header", "hunk-header"]);
		expect(model.hunkNav.map((nav) => nav.rowIndex)).toEqual([0, 3]);
	});

	it("points each hunk at its first line row in full mode", () => {
		const model = buildInlineRows([twoHunks], fullMode);

		const kinds = model.hunkNav.map((nav) => model.rows[nav.rowIndex].kind);

		expect(kinds).toEqual(["line", "line"]);
		expect(model.hunkNav.map((nav) => nav.rowIndex)).toEqual([0, 2]);
	});

	it("keeps the flat index continuous across a hunk header", () => {
		const model = buildInlineRows([twoHunks], { ...fullMode, content: "hunk" });

		const flat = model.rows
			.filter((row) => row.kind === "line")
			.map((row) => row.flatIdx);

		expect(flat).toEqual([0, 1, 2]);
	});
});

// One context line, two deletes and one add: the pairing puts the context on
// both sides, marries the first delete to the add, and leaves the second delete
// facing a phantom.
const pairable = file("src/main.ts", [
	hunk("@@ -1,4 +1,2 @@", [
		line("Context", "first", 1, 1),
		line("Delete", "old a", 2, null),
		line("Delete", "old b", 3, null),
		line("Add", "new a", null, 2),
	]),
]);

describe("buildSplitRows", () => {
	it("emits one pair row per paired line, phantoms included", () => {
		const model = buildSplitRows([pairable], fullMode);

		const sides = model.rows.map((row) =>
			row.kind === "pair"
				? [row.row.left?.lineIdx ?? null, row.row.right?.lineIdx ?? null]
				: row.kind,
		);

		expect(sides).toEqual([
			[0, 0],
			[1, 3],
			[2, null],
		]);
	});

	it("precedes each hunk's pairs with a header row in hunk mode", () => {
		const model = buildSplitRows([twoHunks], { ...fullMode, content: "hunk" });

		expect(model.rows.map((row) => row.kind)).toEqual([
			"hunk-header",
			"pair",
			"pair",
			"hunk-header",
			"pair",
		]);
	});

	it("pairs within each hunk, so a pair reports the hunk it belongs to", () => {
		const model = buildSplitRows([twoHunks], fullMode);

		expect(
			model.rows.map((row) => (row.kind === "pair" ? row.hunkIdx : null)),
		).toEqual([0, 0, 1]);
	});

	it("sizes the gutter to the largest line number's digits plus one", () => {
		const deep = file("src/main.ts", [
			hunk("@@ -998,1 +1000,1 @@", [line("Context", "x", 998, 1000)]),
		]);

		const model = buildSplitRows([deep], fullMode);

		expect(model.gutterChars).toBe(5);
	});

	it("emits a header row per file when the view shows one, and none without", () => {
		const withHeaders = buildSplitRows([pairable], {
			...fullMode,
			fileHeaders: true,
		});

		expect(withHeaders.rows[0].kind).toBe("file-header");
		expect(
			buildSplitRows([pairable], fullMode).rows.some(
				(row) => row.kind === "file-header",
			),
		).toBe(false);
	});

	it("emits only the header row for a collapsed file", () => {
		const model = buildSplitRows([pairable], {
			...fullMode,
			fileHeaders: true,
			collapsed: new Set(["src/main.ts"]),
		});

		expect(model.rows.map((row) => row.kind)).toEqual(["file-header"]);
	});

	it("emits a header row and a binary row, and no pairs, for a binary file", () => {
		const binary = file("assets/logo.png", [], true);

		const model = buildSplitRows([binary], { ...fullMode, fileHeaders: true });

		expect(model.rows.map((row) => row.kind)).toEqual([
			"file-header",
			"binary",
		]);
	});

	it("emits a comment row after the pair its thread anchors to, keyed by the right side", () => {
		const model = buildSplitRows([pairable], {
			...fullMode,
			comments: [thread("t1", "New", 2, 2)],
		});

		expect(model.rows.map((row) => row.kind)).toEqual([
			"pair",
			"pair",
			"comment",
			"pair",
		]);
		const comment = model.rows[2];
		expect(
			comment.kind === "comment" && [
				comment.hunkIdx,
				comment.lineIdx,
				comment.flatIdx,
			],
		).toEqual([0, 3, 3]);
	});

	it("keys a comment row by the left side when the pair has no right side", () => {
		const model = buildSplitRows([pairable], {
			...fullMode,
			comments: [thread("t1", "Old", 3, 3)],
		});

		const comment = model.rows.find((row) => row.kind === "comment");

		expect(
			comment?.kind === "comment" && [comment.lineIdx, comment.flatIdx],
		).toEqual([2, 2]);
	});

	it("holds both sides' threads for one pair in a single comment row", () => {
		const model = buildSplitRows([pairable], {
			...fullMode,
			comments: [thread("tNew", "New", 2, 2), thread("tOld", "Old", 2, 2)],
		});

		const comments = model.rows.filter((row) => row.kind === "comment");

		expect(comments).toHaveLength(1);
		expect(
			comments[0].kind === "comment" && comments[0].threads.map((t) => t.id),
		).toEqual(["tNew", "tOld"]);
	});

	it("omits comment rows when inline comments are hidden", () => {
		const model = buildSplitRows([pairable], {
			...fullMode,
			showInlineComments: false,
			comments: [thread("t1", "New", 2, 2)],
		});

		expect(model.rows.some((row) => row.kind === "comment")).toBe(false);
	});

	it("marks each side spanned from that side's own comments", () => {
		const model = buildSplitRows([pairable], {
			...fullMode,
			comments: [thread("t1", "New", 1, 2)],
		});

		const pairs = model.rows.filter((row) => row.kind === "pair");

		expect(pairs.map((row) => row.spannedRight)).toEqual([true, true, false]);
		expect(pairs.map((row) => row.spannedLeft)).toEqual([false, false, false]);
	});

	it("reports the widest old-side and new-side content as two column entries", () => {
		const lopsided = file("src/main.ts", [
			hunk("@@ -1,2 +1,2 @@", [
				line("Delete", "an old line that runs long", 1, null),
				line("Add", "new", null, 1),
			]),
		]);

		const model = buildSplitRows([lopsided], fullMode);

		expect(model.columns).toEqual(["an old line that runs long".length, 3]);
	});

	it("counts a tab as one cell per side when invisibles are shown", () => {
		const tabbed = file("src/main.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "\tx", 1, 1)]),
		]);

		expect(buildSplitRows([tabbed], fullMode).columns).toEqual([5, 5]);
		expect(
			buildSplitRows([tabbed], { ...fullMode, invisibles: true }).columns,
		).toEqual([2, 2]);
	});

	it("carries each pair's own two column counts, zero for a phantom side", () => {
		const model = buildSplitRows([pairable], fullMode);

		const counts = model.rows.map((row) =>
			row.kind === "pair" ? [row.leftColumns, row.rightColumns] : null,
		);

		expect(counts).toEqual([
			["first".length, "first".length],
			["old a".length, "new a".length],
			["old b".length, 0],
		]);
	});
});

describe("rowIndexForLine", () => {
	it("finds a line's row past the comment rows its hunk carries before it", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			content: "hunk",
			comments: [thread("t1", "New", 1, 1)],
		});

		const index = rowIndexForLine(model, "src/main.ts", 0, 1);

		const row = model.rows[index];
		expect(row.kind === "line" && row.lineIdx).toBe(1);
		expect(model.rows[index - 1].kind).toBe("comment");
	});

	it("resolves a line in a later file rather than the same hunk index in an earlier one", () => {
		const second = file("src/other.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "only", 1, 1)]),
		]);

		const model = buildInlineRows([twoHunks, second], {
			...fullMode,
			content: "hunk",
		});

		const index = rowIndexForLine(model, "src/other.ts", 0, 0);

		const row = model.rows[index];
		expect(row.kind === "line" && row.path).toBe("src/other.ts");
	});

	it("reports no row for a line the model never rendered", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			content: "hunk",
			collapsed: new Set(["src/main.ts"]),
		});

		expect(rowIndexForLine(model, "src/main.ts", 0, 0)).toBe(-1);
	});

	it("finds the pair row carrying a line on its left side", () => {
		const model = buildSplitRows([pairable], { ...fullMode, content: "hunk" });

		const index = rowIndexForLine(model, "src/main.ts", 0, 2);

		const row = model.rows[index];
		expect(row.kind === "pair" && row.row.left?.lineIdx).toBe(2);
	});

	it("finds the pair row carrying a line on its right side", () => {
		const model = buildSplitRows([pairable], { ...fullMode, content: "hunk" });

		const index = rowIndexForLine(model, "src/main.ts", 0, 3);

		const row = model.rows[index];
		expect(row.kind === "pair" && row.row.right?.lineIdx).toBe(3);
	});
});

describe("buildSplitRows navigation", () => {
	it("points each hunk at its header row in hunk mode", () => {
		const model = buildSplitRows([twoHunks], { ...fullMode, content: "hunk" });

		expect(model.hunkNav.map((nav) => [nav.path, nav.hunkIdx])).toEqual([
			["src/main.ts", 0],
			["src/main.ts", 1],
		]);
		expect(model.hunkNav.map((nav) => model.rows[nav.rowIndex].kind)).toEqual([
			"hunk-header",
			"hunk-header",
		]);
	});

	it("points each hunk at its first pair row in full mode", () => {
		const model = buildSplitRows([twoHunks], fullMode);

		expect(model.hunkNav.map((nav) => model.rows[nav.rowIndex].kind)).toEqual([
			"pair",
			"pair",
		]);
		expect(model.hunkNav.map((nav) => nav.rowIndex)).toEqual([0, 2]);
	});
});

const metrics = { charWidthPx: 8, lineHeightPx: 18, monospace: true };

describe("rowHeights", () => {
	it("returns one height per row", () => {
		const model = buildInlineRows([twoHunks], fullMode);

		expect(rowHeights(model, metrics, 80, false, new Map())).toHaveLength(3);
	});

	it("gives every line one line height when wrap is off", () => {
		const long = file("src/main.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "x".repeat(200), 1, 1)]),
		]);
		const model = buildInlineRows([long], fullMode);

		expect(rowHeights(model, metrics, 10, false, new Map())).toEqual([18]);
	});

	it("gives a wrapped line one line height per visual line", () => {
		const long = file("src/main.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "x".repeat(25), 1, 1)]),
		]);
		const model = buildInlineRows([long], fullMode);

		expect(rowHeights(model, metrics, 10, true, new Map())).toEqual([54]);
	});

	it("counts a wrapped line's tab to its stop", () => {
		const tabbed = file("src/main.ts", [
			hunk("@@ -1,1 +1,1 @@", [line("Context", "\t\t\t", 1, 1)]),
		]);
		const model = buildInlineRows([tabbed], fullMode);

		expect(rowHeights(model, metrics, 4, true, new Map())).toEqual([54]);
	});

	it("sums the probed heights of a comment row's threads", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			comments: [thread("t1", "New", 2, 2), thread("t2", "New", 2, 2)],
		});
		const probed = new Map([
			["t1", 60],
			["t2", 40],
		]);

		expect(rowHeights(model, metrics, 80, false, probed)).toEqual([
			18, 18, 100, 18,
		]);
	});

	it("throws rather than guess when a comment row's thread was never probed", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			comments: [thread("t1", "New", 2, 2)],
		});

		expect(() => rowHeights(model, metrics, 80, false, new Map())).toThrow(
			/t1/,
		);
	});

	it("takes each fixed row shape's height from its declared token", () => {
		const binary = file("assets/logo.png", [], true);
		const model = buildInlineRows([binary, twoHunks], {
			...fullMode,
			content: "hunk",
			fileHeaders: true,
		});

		const heights = rowHeights(model, metrics, 80, false, new Map());

		expect(heights.slice(0, 3)).toEqual([
			FIXED_ROW_HEIGHTS.fileHeader,
			FIXED_ROW_HEIGHTS.binary,
			FIXED_ROW_HEIGHTS.fileHeader,
		]);
	});

	it.each([false, true])(
		"never predicts a wrapped row shorter than its columns need, invisibles %s",
		(invisibles) => {
			const awkward = file("src/awkward.ts", [
				hunk("@@ -1,5 +1,5 @@", [
					line("Context", "\tindented", 1, 1),
					line("Context", "trailing   ", 2, 2),
					line("Context", "x".repeat(120), 3, 3),
					line("Context", "", 4, 4),
					line("Context", "\t\tdeep\tnested", 5, 5),
				]),
			]);
			const model = buildInlineRows([awkward], { ...fullMode, invisibles });

			const heights = rowHeights(model, metrics, 10, true, new Map());

			for (const [index, row] of model.rows.entries()) {
				if (row.kind !== "line") continue;
				const needed =
					Math.max(
						1,
						Math.ceil(displayColumns(row.line.content, 4, invisibles) / 10),
					) * metrics.lineHeightPx;
				expect(heights[index]).toBeGreaterThanOrEqual(needed);
			}
		},
	);

	it("gives a pair row one line height when wrap is off", () => {
		const model = buildSplitRows([pairable], fullMode);

		expect(rowHeights(model, metrics, 3, false, new Map())).toEqual([
			18, 18, 18,
		]);
	});

	it("gives a wrapped pair row the taller of its two sides", () => {
		const lopsided = file("src/main.ts", [
			hunk("@@ -1,2 +1,2 @@", [
				line("Delete", "x".repeat(25), 1, null),
				line("Add", "y".repeat(5), null, 1),
			]),
		]);
		const model = buildSplitRows([lopsided], fullMode);

		expect(rowHeights(model, metrics, 10, true, new Map())).toEqual([54]);
	});

	it("needs nothing probed for a hunk header", () => {
		const model = buildInlineRows([twoHunks], {
			...fullMode,
			content: "hunk",
		});

		const heights = rowHeights(model, metrics, 80, false, new Map());

		expect(heights[0]).toBe(FIXED_ROW_HEIGHTS.hunkHeader);
	});
});
