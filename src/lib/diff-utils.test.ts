import { describe, expect, it } from "vitest";
import { pairLines } from "./diff-utils.js";
import type { DiffLine } from "./types.js";

function line(
	origin: DiffLine["origin"],
	content: string,
	oldLineno: number | null,
	newLineno: number | null,
): DiffLine {
	return {
		origin,
		content,
		old_lineno: oldLineno,
		new_lineno: newLineno,
		spans: [],
	};
}

/** git's "\ No newline at end of file", as libgit2 hands it back: a line of the
 *  hunk, with the newline that closes the annotated line still attached. */
function noNewlineMarker(): DiffLine {
	return line("NoNewline", "\n\\ No newline at end of file\n", null, null);
}

describe("pairLines", () => {
	describe("when git's no-newline marker sits inside a run", () => {
		it("seats the replacement it splits in a single row", () => {
			const lines = [
				line("Delete", "last line", 4, null),
				noNewlineMarker(),
				line("Add", "last line\n", null, 4),
			];

			const rows = pairLines(lines);

			expect(rows).toHaveLength(1);
			expect(rows[0].left?.line.content).toBe("last line");
			expect(rows[0].right?.line.content).toBe("last line\n");
		});

		it("keeps each side's lineIdx pointing at its own line", () => {
			const lines = [
				line("Delete", "last line", 4, null),
				noNewlineMarker(),
				line("Add", "last line\n", null, 4),
			];

			const rows = pairLines(lines);

			expect([rows[0].left?.lineIdx, rows[0].right?.lineIdx]).toEqual([0, 2]);
		});

		it("gives the marker no row of its own", () => {
			const lines = [
				line("Context", "a\n", 1, 1),
				line("Delete", "last line", 2, null),
				noNewlineMarker(),
				line("Add", "last line\n", null, 2),
			];

			const rows = pairLines(lines);

			const rendered = rows.flatMap((row) =>
				[row.left?.line.content, row.right?.line.content].filter(
					(content) => content !== undefined,
				),
			);
			expect(rendered).not.toContain("\n\\ No newline at end of file\n");
		});
	});

	describe("when the marker closes a run", () => {
		it("occupies no row after a trailing add", () => {
			const lines = [
				line("Delete", "old\n", 1, null),
				line("Add", "new", null, 1),
				noNewlineMarker(),
			];

			const rows = pairLines(lines);

			expect(rows).toHaveLength(1);
			expect(rows[0].left?.line.content).toBe("old\n");
			expect(rows[0].right?.line.content).toBe("new");
		});

		it("occupies no row after a trailing context line", () => {
			const lines = [
				line("Delete", "x\n", 1, null),
				line("Add", "CHANGED\n", null, 1),
				line("Context", "last", 2, 2),
				noNewlineMarker(),
			];

			const rows = pairLines(lines);

			expect(rows).toHaveLength(2);
			expect(rows[1].left?.line.content).toBe("last");
			expect(rows[1].right?.line.content).toBe("last");
		});
	});

	describe("when both sides lack the final newline", () => {
		it("seats the replacement in one row despite a marker on each side", () => {
			const lines = [
				line("Delete", "old last", 2, null),
				noNewlineMarker(),
				line("Add", "new last", null, 2),
				noNewlineMarker(),
			];

			const rows = pairLines(lines);

			expect(rows).toHaveLength(1);
			expect(rows[0].left?.line.content).toBe("old last");
			expect(rows[0].right?.line.content).toBe("new last");
		});
	});
});
