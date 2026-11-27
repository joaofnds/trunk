import type { DiffRow } from "./diff-rows.js";
import {
	type FoundMatches,
	findLiteralMatches,
	type MatchRange,
} from "./literal-pattern.js";

interface DiffLocation {
	readonly row: number;
	readonly side: "inline" | "old" | "new";
}

export type DiffMatch = DiffLocation & MatchRange;

export function findDiffMatches(
	rows: readonly DiffRow[],
	query: string,
): FoundMatches<DiffMatch> {
	return findLiteralMatches<DiffLocation>(query, (collect) => {
		for (let row = 0; row < rows.length; row++) {
			const entry = rows[row];
			if (entry.kind === "line" && entry.line.origin !== "NoNewline") {
				collect(entry.line.content, { row, side: "inline" });
			} else if (entry.kind === "pair") {
				const { left, right } = entry.row;
				if (left) collect(left.line.content, { row, side: "old" });
				if (right && right.line.origin !== "Context")
					collect(right.line.content, { row, side: "new" });
			}
		}
	});
}
