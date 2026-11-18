import type { MergeRegion } from "./types.js";

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
		return [
			...region.oursLines.filter((_, j) => takenLines.has(`ours-${i}-${j}`)),
			...region.theirsLines.filter((_, j) =>
				takenLines.has(`theirs-${i}-${j}`),
			),
		];
	});
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
	if (lines.length === 0) return [`${side}-${regionIdx}-none`];
	return lines.map((_, j) => `${side}-${regionIdx}-${j}`);
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
