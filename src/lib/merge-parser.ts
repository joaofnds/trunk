/**
 * Pure TypeScript merge parser: conflict region identification,
 * selection state management, real-time output computation,
 * and navigation helpers.
 *
 * All functions are pure (no side effects) and fully tested.
 * The MergeEditor component (Plan 03) imports these functions
 * to drive its reactive state.
 */

export interface ConflictRegion {
	type: "context" | "resolved" | "conflict";
	baseLines: string[];
	oursLines: string[];
	theirsLines: string[];
}

/**
 * Split text into lines. Empty string yields an empty array
 * (not `[""]` which would create a phantom line).
 */
function splitLines(text: string): string[] {
	if (text === "") return [];
	return text.split("\n");
}

/**
 * Build an index mapping line content → sorted array of positions.
 * Used to turn O(n) indexOf scans into O(log n) binary searches.
 */
function buildLineIndex(lines: string[]): Map<string, number[]> {
	const index = new Map<string, number[]>();
	for (let i = 0; i < lines.length; i++) {
		const positions = index.get(lines[i]);
		if (positions) {
			positions.push(i);
		} else {
			index.set(lines[i], [i]);
		}
	}
	return index;
}

/**
 * Binary search for the first value >= minVal in a sorted array.
 * Returns the value, or -1 if none found.
 */
function findFirstGe(positions: number[], minVal: number): number {
	let lo = 0;
	let hi = positions.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (positions[mid] < minVal) lo = mid + 1;
		else hi = mid;
	}
	return lo < positions.length ? positions[lo] : -1;
}

/**
 * Find the next position where all three arrays have the same value,
 * starting the search from the given offsets. Returns the offsets
 * of the sync point, or null if no sync point is found.
 *
 * Uses pre-built line indexes for O(log n) lookups instead of O(n) indexOf.
 */
function findSyncPoint(
	base: string[],
	bi: number,
	oi: number,
	ti: number,
	oursIndex: Map<string, number[]>,
	theirsIndex: Map<string, number[]>,
): { bi: number; oi: number; ti: number } | null {
	for (let b = bi; b < base.length; b++) {
		const needle = base[b];
		const oPositions = oursIndex.get(needle);
		if (!oPositions) continue;
		const oIdx = findFirstGe(oPositions, oi);
		if (oIdx === -1) continue;
		const tPositions = theirsIndex.get(needle);
		if (!tPositions) continue;
		const tIdx = findFirstGe(tPositions, ti);
		if (tIdx === -1) continue;
		return { bi: b, oi: oIdx, ti: tIdx };
	}
	return null;
}

function sameLines(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Classify lines where the three versions diverge. Only a change both sides made
 * differently is a conflict. A change one side made, or both made alike, merges
 * cleanly, as git merges it.
 */
function divergentRegion(
	baseLines: string[],
	oursLines: string[],
	theirsLines: string[],
): ConflictRegion {
	const clean =
		sameLines(oursLines, baseLines) ||
		sameLines(theirsLines, baseLines) ||
		sameLines(oursLines, theirsLines);
	return {
		type: clean ? "resolved" : "conflict",
		baseLines,
		oursLines,
		theirsLines,
	};
}

/** The lines a resolved region merges to: whichever side changed the base. */
function resolvedLines(region: ConflictRegion): string[] {
	if (sameLines(region.oursLines, region.baseLines)) return region.theirsLines;
	return region.oursLines;
}

/**
 * Parse three-way text (base, ours, theirs) into an array of
 * ConflictRegion objects. Each region is one of:
 * - context: lines identical across all three versions
 * - resolved: lines one side changed, or both changed alike
 * - conflict: lines both sides changed differently
 *
 * The parser walks the three texts with one pointer each. Lines all three
 * share are context, and each stretch up to the next point where they agree
 * again is resolved when one side changed it, or both alike, and a conflict
 * otherwise.
 */
export function parseConflictRegions(
	base: string,
	ours: string,
	theirs: string,
): ConflictRegion[] {
	const baseLines = splitLines(base);
	const oursLines = splitLines(ours);
	const theirsLines = splitLines(theirs);

	// Edge case: empty base (new file on both sides)
	if (baseLines.length === 0) {
		// If ours equals theirs, everything is context
		if (ours === theirs) {
			if (oursLines.length === 0) return [];
			return [{ type: "context", baseLines: [], oursLines, theirsLines }];
		}
		// Otherwise, the entire file is one conflict
		return [{ type: "conflict", baseLines: [], oursLines, theirsLines }];
	}

	const oursIndex = buildLineIndex(oursLines);
	const theirsIndex = buildLineIndex(theirsLines);

	const regions: ConflictRegion[] = [];
	let bi = 0;
	let oi = 0;
	let ti = 0;

	while (
		bi < baseLines.length ||
		oi < oursLines.length ||
		ti < theirsLines.length
	) {
		// Check if current lines all match
		if (
			bi < baseLines.length &&
			oi < oursLines.length &&
			ti < theirsLines.length &&
			baseLines[bi] === oursLines[oi] &&
			baseLines[bi] === theirsLines[ti]
		) {
			// Accumulate context lines
			const ctxBase: string[] = [];
			const ctxOurs: string[] = [];
			const ctxTheirs: string[] = [];
			while (
				bi < baseLines.length &&
				oi < oursLines.length &&
				ti < theirsLines.length &&
				baseLines[bi] === oursLines[oi] &&
				baseLines[bi] === theirsLines[ti]
			) {
				ctxBase.push(baseLines[bi]);
				ctxOurs.push(oursLines[oi]);
				ctxTheirs.push(theirsLines[ti]);
				bi++;
				oi++;
				ti++;
			}
			regions.push({
				type: "context",
				baseLines: ctxBase,
				oursLines: ctxOurs,
				theirsLines: ctxTheirs,
			});
		} else {
			// Lines diverge -- find the next sync point
			const sync = findSyncPoint(
				baseLines,
				bi + 1,
				oi + 1,
				ti + 1,
				oursIndex,
				theirsIndex,
			);

			if (sync) {
				regions.push(
					divergentRegion(
						baseLines.slice(bi, sync.bi),
						oursLines.slice(oi, sync.oi),
						theirsLines.slice(ti, sync.ti),
					),
				);
				bi = sync.bi;
				oi = sync.oi;
				ti = sync.ti;
			} else {
				// No sync point found -- the rest of all three diverges as one region
				regions.push(
					divergentRegion(
						baseLines.slice(bi),
						oursLines.slice(oi),
						theirsLines.slice(ti),
					),
				);
				break;
			}
		}
	}

	return regions;
}

/**
 * Compute the merged output text from regions and selection state.
 *
 * For context regions, all lines are included.
 * For resolved regions, the changed side's lines are included.
 * For conflict regions, lines are included if their key is in takenLines.
 * Ours lines come before theirs lines within each conflict region.
 */
export function computeOutput(
	regions: ConflictRegion[],
	takenLines: Set<string>,
): string {
	const lines: string[] = [];

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i];
		if (region.type === "context") {
			// For context, include all lines (oursLines === theirsLines === baseLines)
			lines.push(...region.oursLines);
		} else if (region.type === "resolved") {
			lines.push(...resolvedLines(region));
		} else {
			// For conflict, include taken ours lines first, then taken theirs lines
			region.oursLines.forEach((line, j) => {
				if (takenLines.has(`ours-${i}-${j}`)) {
					lines.push(line);
				}
			});
			region.theirsLines.forEach((line, j) => {
				if (takenLines.has(`theirs-${i}-${j}`)) {
					lines.push(line);
				}
			});
		}
	}

	return lines.join("\n");
}

/**
 * Select all ours lines from all conflict regions.
 * Returns a new Set with keys like "ours-{regionIdx}-{lineIdx}".
 */
export function takeAllCurrent(regions: ConflictRegion[]): Set<string> {
	const keys = new Set<string>();
	for (let i = 0; i < regions.length; i++) {
		if (regions[i].type === "conflict") {
			for (let j = 0; j < regions[i].oursLines.length; j++) {
				keys.add(`ours-${i}-${j}`);
			}
		}
	}
	return keys;
}

/**
 * Select all theirs lines from all conflict regions.
 * Returns a new Set with keys like "theirs-{regionIdx}-{lineIdx}".
 */
export function takeAllIncoming(regions: ConflictRegion[]): Set<string> {
	const keys = new Set<string>();
	for (let i = 0; i < regions.length; i++) {
		if (regions[i].type === "conflict") {
			for (let j = 0; j < regions[i].theirsLines.length; j++) {
				keys.add(`theirs-${i}-${j}`);
			}
		}
	}
	return keys;
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
	regions: ConflictRegion[],
	takenLines: Set<string>,
): Set<string> {
	const region = regions[regionIdx];
	const lines = side === "ours" ? region.oursLines : region.theirsLines;
	const keys = lines.map((_, j) => `${side}-${regionIdx}-${j}`);

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
export function getConflictIndices(regions: ConflictRegion[]): number[] {
	return regions
		.map((r, i) => (r.type === "conflict" ? i : -1))
		.filter((i) => i !== -1);
}
