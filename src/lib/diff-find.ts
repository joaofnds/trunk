import type { DiffRow } from "./diff-rows.js";

export interface DiffMatch {
	readonly row: number;
	readonly side: "inline" | "old" | "new";
	readonly start: number;
	readonly end: number;
}

interface MatchCheckpoint {
	readonly row: number;
	readonly side: DiffMatch["side"];
	readonly content: string;
	readonly index: number;
	readonly offset: number;
}

// Bound the work of stepping backward in a minified file with many hits on one line.
const MATCHES_PER_CHECKPOINT = 256;

export function findDiffMatches(
	rows: readonly DiffRow[],
	query: string,
): {
	readonly length: number;
	at(index: number): DiffMatch | undefined;
} {
	if (!query) return [];

	const checkpoints: MatchCheckpoint[] = [];
	let length = 0;
	const pattern = new RegExp(
		query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		"giu",
	);

	function collect(row: number, side: DiffMatch["side"], content: string) {
		for (let hit = pattern.exec(content); hit; hit = pattern.exec(content)) {
			checkpoints.push({
				row,
				side,
				content,
				index: length,
				offset: hit.index,
			});
			length++;
			for (let i = 1; i < MATCHES_PER_CHECKPOINT; i++) {
				if (!pattern.test(content)) return;
				length++;
			}
		}
	}

	for (let row = 0; row < rows.length; row++) {
		const entry = rows[row];
		if (entry.kind === "line" && entry.line.origin !== "NoNewline") {
			collect(row, "inline", entry.line.content);
		} else if (entry.kind === "pair") {
			const { left, right } = entry.row;
			if (left) collect(row, "old", left.line.content);
			if (right && right.line.origin !== "Context")
				collect(row, "new", right.line.content);
		}
	}

	return {
		length,
		at(index) {
			if (!Number.isInteger(index) || index < 0 || index >= length)
				return undefined;
			let lower = 0;
			let upper = checkpoints.length;
			while (lower + 1 < upper) {
				const mid = Math.floor((lower + upper) / 2);
				if (checkpoints[mid].index <= index) lower = mid;
				else upper = mid;
			}

			const { row, side, content, offset, index: first } = checkpoints[lower];
			pattern.lastIndex = offset;
			for (let skip = first; skip < index; skip++) pattern.test(content);
			const found = pattern.exec(content);
			return found
				? { row, side, start: found.index, end: pattern.lastIndex }
				: undefined;
		},
	};
}
