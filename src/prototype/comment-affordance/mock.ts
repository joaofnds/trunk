import type { DiffOrigin } from "../../lib/types.js";

export interface MockLine {
	origin: DiffOrigin;
	old: number | null;
	new: number | null;
	text: string;
}

const SOURCE: [DiffOrigin, string][] = [
	["Context", "export function parseRange(input: string): Range {"],
	["Context", '\tconst parts = input.split("-");'],
	["Delete", '\tif (parts.length > 2) throw new Error("bad range");'],
	["Add", "\tif (parts.length > 2) {"],
	["Add", '\t\tthrow new RangeError("not a range: " + input);'],
	["Add", "\t}"],
	["Context", "\tconst start = Number(parts[0]);"],
	["Delete", "\tconst end = parts[1] ? Number(parts[1]) : start;"],
	["Add", "\tconst end = parts.length === 2 ? Number(parts[1]) : start;"],
	["Add", "\tif (Number.isNaN(start) || Number.isNaN(end)) {"],
	["Add", '\t\tthrow new RangeError("not a number: " + input);'],
	["Add", "\t}"],
	["Context", "\treturn { start, end };"],
	["Context", "}"],
	["Context", ""],
	["Add", "export function rangeLength(range: Range): number {"],
	["Add", "\treturn Math.abs(range.end - range.start) + 1;"],
	["Add", "}"],
	["Add", ""],
	["Add", "export function contains(range: Range, line: number): boolean {"],
	["Add", "\tconst low = Math.min(range.start, range.end);"],
	["Add", "\tconst high = Math.max(range.start, range.end);"],
	["Add", "\treturn line >= low && line <= high;"],
	["Add", "}"],
	["Context", ""],
	["Context", "export function formatRange(range: Range): string {"],
	["Delete", '\treturn range.start + "-" + range.end;'],
	["Add", "\treturn range.start === range.end"],
	["Add", "\t\t? String(range.start)"],
	["Add", '\t\t: range.start + "-" + range.end;'],
	["Context", "}"],
];

/** One hunk of a TypeScript change, numbered as git numbers it. */
export function mockLines(): MockLine[] {
	let oldNo = 40;
	let newNo = 40;
	return SOURCE.map(([origin, text]) => {
		const line: MockLine = {
			origin,
			old: origin === "Add" ? null : oldNo,
			new: origin === "Delete" ? null : newNo,
			text,
		};
		if (origin !== "Add") oldNo++;
		if (origin !== "Delete") newNo++;
		return line;
	});
}
