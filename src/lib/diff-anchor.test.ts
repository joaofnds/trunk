import { describe, expect, it } from "vitest";
import { buildDiffAnchor, hunkSelectableIndices } from "./diff-anchor.js";
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

describe("buildDiffAnchor", () => {
	it("resolves a pure-Add selection on a Modified file to the New side over new_lineno", () => {
		const lines = [
			contextLine(40, 40, "ctx"),
			addLine(41, "first"),
			addLine(42, "second"),
		];
		const f = file("Modified", "src/a.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([1, 2]));

		expect(anchor.side).toBe("New");
		expect(anchor.start_line).toBe(41);
		expect(anchor.end_line).toBe(42);
	});

	it("resolves a pure-Delete selection to the Old side over old_lineno", () => {
		const lines = [
			contextLine(15, 15, "ctx"),
			deleteLine(16, "gone-one"),
			deleteLine(17, "gone-two"),
		];
		const f = file("Modified", "src/b.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([1, 2]));

		expect(anchor.side).toBe("Old");
		expect(anchor.start_line).toBe(16);
		expect(anchor.end_line).toBe(17);
	});

	it("resolves a mixed Add+Delete selection to New, drops Delete linenos from the range, keeps them in the excerpt", () => {
		// Delete's old_lineno (99) sits OUTSIDE the Add range so a buggy impl that
		// folded it in (e.g. new_lineno ?? old_lineno) would widen the range to 16..99.
		const lines = [
			deleteLine(99, "old-line"),
			addLine(16, "new-line-a"),
			addLine(17, "new-line-b"),
		];
		const f = file("Modified", "src/c.ts", lines);

		const { anchor, cachedExcerpt } = buildDiffAnchor(
			OID,
			f,
			0,
			new Set([0, 1, 2]),
		);

		expect(anchor.side).toBe("New");
		// Range is min..max of the Add lines' new_lineno only — the Delete's old_lineno (99)
		// must not widen the range; 16..17 comes from the Add lines alone.
		expect(anchor.start_line).toBe(16);
		expect(anchor.end_line).toBe(17);
		// Excerpt still carries the dropped `-` line.
		expect(cachedExcerpt).toContain("-old-line");
		expect(cachedExcerpt).toContain("+new-line-a");
	});

	it("collapses a non-contiguous selection to min..max of the chosen side without rejection", () => {
		const lines = [
			addLine(10, "ten"),
			contextLine(11, 11, "eleven-ctx"),
			addLine(12, "twelve"),
			contextLine(13, 13, "thirteen-ctx"),
			addLine(14, "fourteen"),
		];
		const f = file("Modified", "src/d.ts", lines);

		// Gap: select indices 0 and 4 only.
		const { anchor, cachedExcerpt } = buildDiffAnchor(
			OID,
			f,
			0,
			new Set([0, 4]),
		);

		expect(anchor.side).toBe("New");
		expect(anchor.start_line).toBe(10);
		expect(anchor.end_line).toBe(14);
		// Excerpt spans the contiguous index range 0..4, so in-between context appears.
		expect(cachedExcerpt).toContain(" eleven-ctx");
		expect(cachedExcerpt).toContain(" thirteen-ctx");
	});

	it("forces side New for an Added file regardless of selected origins", () => {
		const lines = [addLine(1, "brand-new")];
		const f = file("Added", "src/new.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0]));

		expect(anchor.side).toBe("New");
		expect(anchor.start_line).toBe(1);
		expect(anchor.end_line).toBe(1);
	});

	it("forces side Old for a Deleted file", () => {
		const lines = [deleteLine(1, "removed-one"), deleteLine(2, "removed-two")];
		const f = file("Deleted", "src/old.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0, 1]));

		expect(anchor.side).toBe("Old");
		expect(anchor.start_line).toBe(1);
		expect(anchor.end_line).toBe(2);
	});

	it("forces side New and stores the new path for a Renamed file", () => {
		const lines = [addLine(5, "renamed-content")];
		const f = file("Renamed", "src/renamed-new-path.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0]));

		expect(anchor.side).toBe("New");
		expect(anchor.file_path).toBe("src/renamed-new-path.ts");
	});

	it("treats a Copied file like Renamed: side New and the new path", () => {
		const lines = [addLine(3, "copied-content")];
		const f = file("Copied", "src/copied-new-path.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0]));

		expect(anchor.side).toBe("New");
		expect(anchor.file_path).toBe("src/copied-new-path.ts");
	});

	it("treats an Untracked file like Modified — side derived from selected origins", () => {
		const lines = [deleteLine(8, "del")];
		const f = file("Untracked", "src/untracked.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0]));

		expect(anchor.side).toBe("Old");
	});

	it("treats an Unknown file like Modified — side derived from selected origins", () => {
		const lines = [addLine(9, "add")];
		const f = file("Unknown", "src/unknown.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0]));

		expect(anchor.side).toBe("New");
	});

	it("assembles cachedExcerpt as origin-prefixed diff-format lines over the contiguous index span", () => {
		const lines = [
			contextLine(40, 40, "before"),
			deleteLine(41, "removed"),
			addLine(41, "added"),
			contextLine(42, 42, "after"),
		];
		const f = file("Modified", "src/e.ts", lines);

		const { cachedExcerpt } = buildDiffAnchor(OID, f, 0, new Set([1, 2]));

		// Selection is indices 1..2, so the contiguous span is exactly those two lines.
		expect(cachedExcerpt).toBe("-removed\n+added");
	});

	it("produces an anchor with exactly the six schema fields and no array-index metadata", () => {
		const lines = [addLine(1, "x")];
		const f = file("Modified", "src/f.ts", lines);

		const { anchor } = buildDiffAnchor(OID, f, 0, new Set([0]));

		expect(Object.keys(anchor).sort()).toEqual([
			"commit_oid",
			"end_line",
			"file_path",
			"side",
			"source",
			"start_line",
		]);
		expect(anchor.source).toBe("Diff");
		expect(anchor.commit_oid).toBe(OID);
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

describe("hunkSelectableIndices", () => {
	it("returns only the non-context indices of a mixed Add/Delete/Context hunk", () => {
		const h = hunk([
			contextLine(40, 40, "ctx"),
			deleteLine(41, "gone"),
			addLine(41, "new"),
			contextLine(42, 42, "ctx"),
		]);

		expect(hunkSelectableIndices(h)).toEqual(new Set([1, 2]));
	});

	it("returns every index of a pure-Add hunk", () => {
		const h = hunk([addLine(1, "a"), addLine(2, "b")]);

		expect(hunkSelectableIndices(h)).toEqual(new Set([0, 1]));
	});

	it("returns every index of a pure-Delete hunk", () => {
		const h = hunk([deleteLine(1, "a"), deleteLine(2, "b")]);

		expect(hunkSelectableIndices(h)).toEqual(new Set([0, 1]));
	});

	it("returns an empty set for a pure-context hunk", () => {
		const h = hunk([contextLine(1, 1, "a"), contextLine(2, 2, "b")]);

		expect(hunkSelectableIndices(h)).toEqual(new Set());
	});
});
