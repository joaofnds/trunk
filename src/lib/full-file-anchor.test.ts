import { describe, expect, it } from "vitest";
import {
	buildFullFileAnchor,
	fileSelectableIndices,
} from "./full-file-anchor.js";
import type { DiffHunk, DiffLine, DiffStatus, FileDiff } from "./types.js";

function addLine(newLineno: number, content: string): DiffLine {
	return {
		origin: "Add",
		content,
		old_lineno: null,
		new_lineno: newLineno,
		spans: [],
	};
}

function deleteLine(oldLineno: number, content: string): DiffLine {
	return {
		origin: "Delete",
		content,
		old_lineno: oldLineno,
		new_lineno: null,
		spans: [],
	};
}

function contextLine(
	oldLineno: number,
	newLineno: number,
	content: string,
): DiffLine {
	return {
		origin: "Context",
		content,
		old_lineno: oldLineno,
		new_lineno: newLineno,
		spans: [],
	};
}

// Single-hunk file (mirrors diff-anchor.test.ts). The full-file adapter reads the
// flat line list via file.hunks.flatMap(h => h.lines), so a single hunk is enough
// to express any flat sequence — including new_lineno gaps via explicit values.
function file(status: DiffStatus, path: string, lines: DiffLine[]): FileDiff {
	return {
		path,
		old_path: null,
		status,
		is_binary: false,
		hunks: [
			{
				header: "@@ -1,4 +1,4 @@",
				old_start: 1,
				old_lines: lines.length,
				new_start: 1,
				new_lines: lines.length,
				lines,
			},
		],
	};
}

const OID = "abc123";

describe("buildFullFileAnchor", () => {
	it("V1: yields a FullFile/New anchor with start/end = min/max new_lineno for a contiguous span", () => {
		const lines = [
			contextLine(40, 40, "ctx"),
			addLine(41, "first"),
			addLine(42, "second"),
		];
		const f = file("Modified", "src/a.ts", lines);

		const { anchor } = buildFullFileAnchor(OID, f, new Set([1, 2]));

		expect(anchor.source).toBe("FullFile");
		expect(anchor.side).toBe("New");
		expect(anchor.start_line).toBe(41);
		expect(anchor.end_line).toBe(42);
		expect(anchor.commit_oid).toBe(OID);
		expect(anchor.file_path).toBe("src/a.ts");
	});

	it("V1: a single-line selection yields start_line === end_line === that line's new_lineno", () => {
		const lines = [contextLine(7, 7, "only")];
		const f = file("Modified", "src/single.ts", lines);

		const { anchor } = buildFullFileAnchor(OID, f, new Set([0]));

		expect(anchor.start_line).toBe(7);
		expect(anchor.end_line).toBe(7);
	});

	it("V2: a span passing over a Delete line excludes it from BOTH the range and the excerpt", () => {
		// The Delete line's old_lineno (99) sits outside the new-side range; a buggy
		// impl folding it in would widen the range to 41..99.
		const lines = [
			addLine(41, "kept-a"),
			deleteLine(99, "gone"),
			addLine(42, "kept-b"),
		];
		const f = file("Modified", "src/b.ts", lines);

		const { anchor, cachedExcerpt } = buildFullFileAnchor(
			OID,
			f,
			new Set([0, 1, 2]),
		);

		expect(anchor.start_line).toBe(41);
		expect(anchor.end_line).toBe(42);
		expect(cachedExcerpt).toBe("kept-a\nkept-b");
		expect(cachedExcerpt).not.toContain("gone");
	});

	it("V3: cachedExcerpt is plain new-side content joined by newline, with no +/-/space prefix", () => {
		const lines = [
			addLine(10, "const x = 1;"),
			addLine(11, "const y = 2;"),
			addLine(12, "return x + y;"),
		];
		const f = file("Modified", "src/c.ts", lines);

		const { cachedExcerpt } = buildFullFileAnchor(OID, f, new Set([0, 1, 2]));

		expect(cachedExcerpt).toBe("const x = 1;\nconst y = 2;\nreturn x + y;");
		expect(cachedExcerpt.startsWith("+")).toBe(false);
		expect(cachedExcerpt.startsWith(" ")).toBe(false);
	});

	it("V4: a gap-crossing span keeps a correct blob range and inserts a '… N lines unchanged …' marker", () => {
		// new_lineno jumps 5 -> 50 across the span (a dropped-hunk boundary). The
		// range still spans the gap (blob coords are monotonic) and the excerpt
		// inserts a single marker with N = 50 - 5 - 1 = 44.
		const lines = [
			contextLine(5, 5, "before-gap"),
			contextLine(50, 50, "after-gap"),
		];
		const f = file("Modified", "src/d.ts", lines);

		const { anchor, cachedExcerpt } = buildFullFileAnchor(
			OID,
			f,
			new Set([0, 1]),
		);

		expect(anchor.start_line).toBe(5);
		expect(anchor.end_line).toBe(50);
		expect(cachedExcerpt).toBe("before-gap\n… 44 lines unchanged …\nafter-gap");
	});
});

function hunk(lines: DiffLine[]): DiffHunk {
	return {
		header: "@@ -1,1 +1,1 @@",
		old_start: 1,
		old_lines: lines.length,
		new_start: 1,
		new_lines: lines.length,
		lines,
	};
}

describe("fileSelectableIndices", () => {
	it("returns the flat indices of every new-side line, excluding Delete lines", () => {
		const lines = [
			contextLine(40, 40, "ctx"),
			deleteLine(99, "gone"),
			addLine(41, "added"),
		];
		const f = file("Modified", "src/a.ts", lines);

		expect(fileSelectableIndices(f)).toEqual(new Set([0, 2]));
	});

	it("indices are continuous across multiple hunks (flat over hunks.flatMap)", () => {
		const f: FileDiff = {
			path: "src/multi.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				hunk([addLine(1, "h1-a"), deleteLine(2, "h1-del")]),
				hunk([addLine(50, "h2-a"), addLine(51, "h2-b")]),
			],
		};

		// Flat list: [add, delete, add, add] -> new-side at flat indices 0, 2, 3.
		expect(fileSelectableIndices(f)).toEqual(new Set([0, 2, 3]));
	});

	it("is empty for a pure-deletion file (no new side)", () => {
		const lines = [deleteLine(1, "gone-a"), deleteLine(2, "gone-b")];
		const f = file("Deleted", "src/dead.ts", lines);

		expect(fileSelectableIndices(f)).toEqual(new Set());
	});
});
