import type { MergeRegion } from "./types.js";

export function pickKey(
	side: string,
	region: number,
	line: number | "none",
): string {
	return `${side}-${region}-${line}`;
}

export function* pickedConflictLines(
	region: Extract<MergeRegion, { type: "conflict" }>,
	index: number,
	taken: ReadonlySet<string>,
) {
	for (const side of ["ours", "theirs"] as const) {
		const lines = side === "ours" ? region.oursLines : region.theirsLines;
		for (let i = 0; i < lines.length; i++) {
			const key = pickKey(side, index, i);
			if (taken.has(key)) yield { key, text: lines[i] };
		}
	}
}

/**
 * The merged output's lines, one list per region: the text git merged, and for
 * a conflict the lines taken from it, the current side's before the incoming.
 */
export function outputRegions(
	regions: readonly MergeRegion[],
	takenLines: Set<string>,
): (readonly string[])[] {
	return regions.map((region, i) => {
		if (region.type === "merged") return region.mergedLines;
		return Array.from(
			pickedConflictLines(region, i, takenLines),
			(line) => line.text,
		);
	});
}

/** The line ending most of the file's lines carry, which typed output is saved
 *  with because a textarea hands back every line ending as a bare newline. */
export function lineEndingOf(regions: readonly MergeRegion[]): "\r\n" | "\n" {
	// A separator exists between consecutive entries of each source stream.
	let breaks = 0;
	let crlf = 0;
	for (const side of ["oursLines", "theirsLines"] as const) {
		let previous: string | undefined;
		for (const region of regions) {
			const lines =
				region.type === "merged" ? region.mergedLines : region[side];
			for (const line of lines) {
				if (previous !== undefined) {
					breaks++;
					if (previous.endsWith("\r")) crlf++;
				}
				previous = line;
			}
		}
	}
	return crlf * 2 > breaks ? "\r\n" : "\n";
}

/** The textarea reports LF throughout. Preserve the original bytes outside
 * the edited range, including the individual endings of mixed-ending files. */
export function editedOutput(
	previous: string,
	value: string,
	ending: string,
	edit?: { start: number; end: number },
): string {
	if (ending === "\n" && !previous.includes("\r")) return value;
	let from = 0,
		start = 0;
	let to = previous.length,
		end = value.length;
	const prefixLimit = edit ? Math.min(edit.start, edit.end) : end;
	while (from < to && start < prefixLimit) {
		const cr = previous[from] === "\r";
		if ((cr ? "\n" : previous[from]) !== value[start]) break;
		from += cr && previous[from + 1] === "\n" ? 2 : 1;
		start++;
	}
	const suffixLimit = edit?.end ?? start;
	while (to > from && end > suffixLimit) {
		const last = previous[to - 1];
		if ((last === "\r" ? "\n" : last) !== value[end - 1]) break;
		to -= last === "\n" && to - 1 > from && previous[to - 2] === "\r" ? 2 : 1;
		end--;
	}
	return (
		previous.slice(0, from) +
		value.slice(start, end).replaceAll("\n", ending) +
		previous.slice(to)
	);
}

/** Native Undo can combine several input events. Keep their byte-level changes
 * only for buffers where normalizing a newline would throw away its spelling. */
export function createMergeEditHistory() {
	type Change = { at: number; before: string; after: string };
	const changes: Change[] = [];
	let cursor = 0;
	let last: string | undefined;
	return (
		previous: string,
		value: string,
		ending: string,
		edit?: { start: number; end: number },
		inputType?: string,
	) => {
		if (previous !== last) {
			changes.length = 0;
			cursor = 0;
		}
		const undo = inputType === "historyUndo";
		if (undo || inputType === "historyRedo") {
			let raw = previous;
			let i = cursor;
			while (undo ? i > 0 : i < changes.length) {
				const change = changes[undo ? --i : i++];
				const removed = undo ? change.after : change.before;
				const added = undo ? change.before : change.after;
				raw =
					raw.slice(0, change.at) +
					added +
					raw.slice(change.at + removed.length);
				if (raw.replace(/\r\n?/g, "\n") === value) {
					cursor = i;
					last = raw;
					return raw;
				}
			}
		}
		const next = editedOutput(previous, value, ending, edit);
		// A file using only its default ending can rely on the native undo stack.
		if (
			changes.length ||
			(ending === "\n"
				? previous.includes("\r")
				: /\r(?!\n)|(?<!\r)\n/.test(previous))
		) {
			let at = 0;
			const common = Math.min(previous.length, next.length);
			while (at < common && previous[at] === next[at]) at++;
			let tail = 0;
			while (
				tail < common - at &&
				previous[previous.length - tail - 1] === next[next.length - tail - 1]
			)
				tail++;
			changes.splice(cursor, changes.length - cursor, {
				at,
				before: previous.slice(at, previous.length - tail),
				after: next.slice(at, next.length - tail),
			});
			cursor++;
		}
		last = next;
		return next;
	};
}

/** The merged output text from regions and selection state. */
export function computeOutput(
	regions: readonly MergeRegion[],
	takenLines: Set<string>,
): string {
	return outputRegions(regions, takenLines).flat().join("\n");
}

/**
 * The selection keys of one side of a conflict: one per line, or a single
 * "{side}-{regionIdx}-none" key for a side that deleted the lines, so taking
 * the deletion is a choice the selection records.
 */
export function sideKeys(
	side: "ours" | "theirs",
	regionIdx: number,
	regions: readonly MergeRegion[],
): string[] {
	const region = regions[regionIdx];
	const lines = side === "ours" ? region.oursLines : region.theirsLines;
	if (lines.length === 0) return [pickKey(side, regionIdx, "none")];
	return lines.map((_, j) => pickKey(side, regionIdx, j));
}

function takeAll(
	side: "ours" | "theirs",
	regions: readonly MergeRegion[],
): Set<string> {
	const keys = new Set<string>();
	for (const i of getConflictIndices(regions)) {
		for (const key of sideKeys(side, i, regions)) keys.add(key);
	}
	return keys;
}

/** Take the ours side of every conflict region. */
export function takeAllCurrent(regions: readonly MergeRegion[]): Set<string> {
	return takeAll("ours", regions);
}

/** Take the theirs side of every conflict region. */
export function takeAllIncoming(regions: readonly MergeRegion[]): Set<string> {
	return takeAll("theirs", regions);
}

/** How many conflicts have nothing taken from either side. */
export function countUnresolved(
	regions: readonly MergeRegion[],
	takenLines: Set<string>,
): number {
	return getConflictIndices(regions).filter(
		(i) =>
			![
				...sideKeys("ours", i, regions),
				...sideKeys("theirs", i, regions),
			].some((key) => takenLines.has(key)),
	).length;
}

/**
 * Toggle all lines from one side of a conflict region.
 *
 * If ALL lines from that side in that region are already taken,
 * remove them all (untoggle). Otherwise add them all (toggle on).
 * Returns a new Set (immutable update).
 */
export function toggleHunk(
	side: "ours" | "theirs",
	regionIdx: number,
	regions: readonly MergeRegion[],
	takenLines: Set<string>,
): Set<string> {
	const keys = sideKeys(side, regionIdx, regions);

	const allTaken = keys.every((k) => takenLines.has(k));
	const result = new Set(takenLines);

	if (allTaken) {
		// Remove all
		for (const k of keys) {
			result.delete(k);
		}
	} else {
		// Add all
		for (const k of keys) {
			result.add(k);
		}
	}

	return result;
}

/**
 * Toggle a single line in the selection state.
 * If the key is present, remove it. Otherwise add it.
 * Returns a new Set (immutable update).
 */
export function toggleLine(key: string, takenLines: Set<string>): Set<string> {
	const result = new Set(takenLines);
	if (result.has(key)) {
		result.delete(key);
	} else {
		result.add(key);
	}
	return result;
}

/**
 * Return indices of all conflict regions (for Prev/Next navigation).
 */
export function getConflictIndices(regions: readonly MergeRegion[]): number[] {
	return regions
		.map((r, i) => (r.type === "conflict" ? i : -1))
		.filter((i) => i !== -1);
}
