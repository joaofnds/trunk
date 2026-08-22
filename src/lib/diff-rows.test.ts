import { describe, expect, it } from "vitest";
import { type BuildOptions, buildInlineRows } from "./diff-rows.js";
import type { DiffHunk, DiffLine, DiffOrigin, FileDiff } from "./types.js";

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
	return { path, status: "Modified", is_binary: isBinary, hunks };
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

		expect(model.rows.map((row) => row.kind)).toEqual([
			"line",
			"line",
			"line",
		]);
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

	it("keeps the flat index continuous across a hunk header", () => {
		const model = buildInlineRows([twoHunks], { ...fullMode, content: "hunk" });

		const flat = model.rows
			.filter((row) => row.kind === "line")
			.map((row) => row.flatIdx);

		expect(flat).toEqual([0, 1, 2]);
	});
});
