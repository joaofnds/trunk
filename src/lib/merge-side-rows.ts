import { BAR_HEIGHT } from "./chrome-heights.js";
import { pairedIndices } from "./diff-utils.js";
import { columnsUpTo } from "./display-columns.js";
import { pickedConflictLines, pickKey } from "./merge-parser.js";
import { layoutFrom, mapOffset, regionAt } from "./merge-scroll.js";
import type { MergeRegion, MergeSides } from "./types.js";
import { buildOffsets, windowFor } from "./virtual-window.js";

export const MERGE_LINE_HEIGHT = 18;
export const CONFLICT_HEADER_HEIGHT = BAR_HEIGHT + 1;

export function mergeLineHeight(text: string, wrapColumns: number) {
	if (wrapColumns <= 0) return MERGE_LINE_HEIGHT;
	const content = text.endsWith("\r") ? text.slice(0, -1) : text;
	if (!/[\t\u0080-\uFFFF]/.test(content))
		return (
			Math.max(1, Math.ceil(content.length / wrapColumns)) * MERGE_LINE_HEIGHT
		);

	let rows = 0;
	for (let at = 0; at < content.length; rows++) {
		const remaining = content.slice(at);
		const units = columnsUpTo(remaining, wrapColumns, 4, false);
		at += units || String.fromCodePoint(remaining.codePointAt(0) ?? 0).length;
	}
	return Math.max(1, rows) * MERGE_LINE_HEIGHT;
}

export type MergeSide = "ours" | "theirs";

export interface SideLine {
	text: string;
	lineNum: number;
	key: string;
}

export type MergeSideRow = {
	regionIdx: number;
	slot: number;
	conflictNum: number;
	ours?: SideLine;
	theirs?: SideLine;
	height: number;
} & (
	| { type: "gap"; hidden: number; hiddenBySide: Record<MergeSide, number> }
	| { type: "context" | "conflict-header" | "conflict-line" }
);

function sourceLine(
	lines: readonly string[],
	index: number,
	firstLine: number,
	key: string,
): SideLine | undefined {
	if (index < 0 || index >= lines.length) return undefined;
	return { text: lines[index], lineNum: firstLine + index, key };
}

export function buildMergeSideRows(
	regions: readonly MergeRegion[],
	context: number | null,
	expanded: ReadonlySet<number>,
	wrapColumns: number,
	measured?: ReadonlyMap<string, number>,
	conflictPartners?: MergeSides["conflict_partners"],
) {
	const rows: MergeSideRow[] = [];
	const gaps = new Map<number, { row: number; head: number; tail: number }>();
	const regionTops = [0];
	const regionRows = [0];
	let oursFirst = 1;
	let theirsFirst = 1;
	let conflictNum = 0;

	for (const [regionIdx, region] of regions.entries()) {
		const conflict = region.type === "conflict";
		const ours = region.oursLines;
		const theirs = region.theirsLines;
		const partners = conflictPartners?.[regionIdx];
		const pairs =
			partners && Array.from(pairedIndices(partners, theirs.length));
		const slots = pairs?.length ?? Math.max(ours.length, theirs.length);
		const firstRow = rows.length;
		if (conflict) {
			conflictNum++;
			rows.push({
				type: "conflict-header",
				regionIdx,
				slot: -1,
				conflictNum,
				height: CONFLICT_HEADER_HEIGHT,
			});
		}

		const folding = !conflict && context !== null && !expanded.has(regionIdx);
		const head =
			folding && regions[regionIdx - 1]?.type === "conflict" ? context : 0;
		const tail =
			folding && regions[regionIdx + 1]?.type === "conflict" ? context : 0;
		const hidden = folding ? slots - head - tail : 0;
		for (let slot = 0; slot < slots; slot++) {
			if (hidden > 0 && slot === head) {
				gaps.set(regionIdx, { row: rows.length, head, tail });
				rows.push({
					type: "gap",
					regionIdx,
					slot,
					conflictNum,
					hidden,
					hiddenBySide: {
						ours: Math.max(0, ours.length - head - tail),
						theirs: Math.max(0, theirs.length - head - tail),
					},
					height: BAR_HEIGHT,
				});
				slot += hidden - 1;
				continue;
			}

			// Each side keeps its own last lines before a conflict, even when Git
			// merged an insertion on only one side of the gap.
			const suffix = hidden > 0 && slot >= slots - tail;
			const oursIdx =
				pairs?.[slot][0] ?? (suffix ? ours.length - (slots - slot) : slot);
			const theirsIdx =
				pairs?.[slot][1] ?? (suffix ? theirs.length - (slots - slot) : slot);
			const left =
				suffix && oursIdx < head
					? undefined
					: sourceLine(
							ours,
							oursIdx,
							oursFirst,
							pickKey("ours", regionIdx, oursIdx),
						);
			const right =
				suffix && theirsIdx < head
					? undefined
					: sourceLine(
							theirs,
							theirsIdx,
							theirsFirst,
							pickKey("theirs", regionIdx, theirsIdx),
						);
			rows.push({
				type: conflict ? "conflict-line" : "context",
				regionIdx,
				slot,
				conflictNum,
				ours: left,
				theirs: right,
				height: Math.max(
					left
						? (measured?.get(left.key) ??
								mergeLineHeight(left.text, wrapColumns))
						: MERGE_LINE_HEIGHT,
					right
						? (measured?.get(right.key) ??
								mergeLineHeight(right.text, wrapColumns))
						: MERGE_LINE_HEIGHT,
				),
			});
		}

		oursFirst += ours.length;
		theirsFirst += theirs.length;
		let top = regionTops[regionIdx];
		for (let i = firstRow; i < rows.length; i++) top += rows[i].height;
		regionTops.push(top);
		regionRows.push(rows.length);
	}

	return {
		rows,
		regionRows,
		gaps,
		regionTops,
		offsets: buildOffsets(rows.map((row) => row.height)),
	};
}

export function reflowedSideTop({
	before,
	after,
	top,
	viewport,
	focusedRegion,
	readingSide = "ours",
}: {
	before: ReturnType<typeof buildMergeSideRows>;
	after: ReturnType<typeof buildMergeSideRows>;
	top: number;
	viewport: number;
	focusedRegion?: number;
	readingSide?: MergeSide;
}): number {
	if (focusedRegion !== undefined) {
		const header = before.regionTops[focusedRegion];
		if (header >= top && header < top + viewport)
			return Math.max(0, after.regionTops[focusedRegion] - (header - top));
	}

	const first = windowFor(before.offsets, top, 0, 0).start;
	const anchor = before.rows[first];
	if (!anchor) return 0;

	const sourceSide = anchor[readingSide]
		? readingSide
		: readingSide === "ours"
			? "theirs"
			: "ours";
	const sourceKey = anchor[sourceSide]?.key;
	let index =
		sourceKey === undefined
			? -1
			: after.rows.findIndex((row) => row[sourceSide]?.key === sourceKey);
	if (index < 0 && sourceKey !== undefined)
		index = after.gaps.get(anchor.regionIdx)?.row ?? -1;
	if (index < 0)
		index = after.rows.findIndex(
			(row) => row.regionIdx === anchor.regionIdx && row.slot === anchor.slot,
		);
	if (index < 0) return top;

	const within = Math.min(
		top - before.offsets[first],
		after.rows[index].height - 1,
	);
	return after.offsets[index] + within;
}

/** In a region Git merged automatically, a visible line can come from either
 *  side. Match in file order; the lines only one side has may be absent from
 *  Output or may have moved the matching line to another aligned row. */
function anchorContext(
	model: ReturnType<typeof buildMergeSideRows>,
	startRow: number,
	endRow: number,
	lines: readonly string[],
	startLine: number,
	endLine: number,
	anchor: (row: number, line: number) => void,
) {
	let cursor = startLine;
	let indices: Map<string, number[]> | undefined;
	function nextMatch(text: string | undefined) {
		if (text === undefined) return endLine;
		if (!indices) {
			indices = new Map();
			for (let i = cursor; i < endLine; i++) {
				const matches = indices.get(lines[i]);
				if (matches) matches.push(i);
				else indices.set(lines[i], [i]);
			}
		}
		const matches = indices.get(text);
		if (!matches) return endLine;
		let low = 0;
		let high = matches.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (matches[middle] < cursor) low = middle + 1;
			else high = middle;
		}
		return matches[low] ?? endLine;
	}

	for (let i = startRow; i < endRow && cursor < endLine; i++) {
		const { ours, theirs } = model.rows[i];
		let match = cursor;
		if (lines[cursor] !== ours?.text && lines[cursor] !== theirs?.text)
			match = Math.min(nextMatch(ours?.text), nextMatch(theirs?.text));
		if (match === endLine) continue;

		anchor(i, match);
		anchor(i + 1, match + 1);
		cursor = match + 1;
	}
}

function anchors() {
	const side: number[] = [];
	const output: number[] = [];

	// Consecutive short lines share one slope; a long file with the same
	// geometry in both panes only needs its first and last scroll anchors.
	function append(x: number, y: number) {
		const last = side.length - 1;
		if (side[last] === x && output[last] === y) return;
		if (
			last > 0 &&
			(x - side[last]) * (output[last] - output[last - 1]) ===
				(y - output[last]) * (side[last] - side[last - 1])
		) {
			side[last] = x;
			output[last] = y;
		} else {
			side.push(x);
			output.push(y);
		}
	}
	return { side, output, append };
}

interface RegionScroll {
	height: number;
	toOutput(side: MergeSide, y: number): number;
	toSide(y: number): number;
}

type SideRows = ReturnType<typeof buildMergeSideRows>;

function contextScroll(
	model: SideRows,
	index: number,
	lines: readonly string[],
	columns: number,
): RegionScroll {
	const { side, output, append } = anchors();
	append(0, 0);
	const start = model.regionRows[index];
	const end = model.regionRows[index + 1];
	const heights =
		columns > 0
			? buildOffsets(lines.map((line) => mergeLineHeight(line, columns)))
			: null;
	const anchor = (row: number, line: number) =>
		append(
			model.offsets[row] - model.regionTops[index],
			heights ? heights[line] : line * MERGE_LINE_HEIGHT,
		);
	const gap = model.gaps.get(index);
	if (gap) {
		const head = Math.min(gap.head, lines.length);
		const tail = Math.max(head, lines.length - gap.tail);
		anchorContext(model, start, gap.row, lines, 0, head, anchor);
		anchor(gap.row, head);
		anchor(gap.row + 1, tail);
		anchorContext(model, gap.row + 1, end, lines, tail, lines.length, anchor);
	} else {
		anchorContext(model, start, end, lines, 0, lines.length, anchor);
	}
	anchor(end, lines.length);
	return {
		height: output[output.length - 1],
		toOutput: (_, y) => mapOffset(side, output, y),
		toSide: (y) => mapOffset(output, side, y),
	};
}

function conflictScroll(
	model: SideRows,
	index: number,
	region: Extract<MergeRegion, { type: "conflict" }>,
	columns: number,
	taken: ReadonlySet<string>,
): RegionScroll {
	const base = model.regionTops[index];
	const start = model.regionRows[index];
	const end = model.regionRows[index + 1];
	const sourceHeight = model.regionTops[index + 1] - base;
	const picks = new Map<
		string,
		{ top: number; bottom: number; row?: number }
	>();
	let height = 0;
	for (const { key, text } of pickedConflictLines(region, index, taken)) {
		const top = height;
		height += mergeLineHeight(text, columns);
		picks.set(key, { top, bottom: height });
	}

	const ours = anchors();
	const theirs = anchors();
	ours.append(0, 0);
	theirs.append(0, 0);
	for (let row = start; row < end; row++) {
		const { ours: left, theirs: right } = model.rows[row];
		const currentPick = left && picks.get(left.key);
		const incomingPick = right && picks.get(right.key);
		if (currentPick) currentPick.row = row;
		if (incomingPick) incomingPick.row = row;
		for (const [map, pick] of [
			[ours, currentPick ?? incomingPick],
			[theirs, incomingPick ?? currentPick],
		] as const) {
			if (!pick) continue;
			map.append(model.offsets[row] - base, pick.top);
			map.append(model.offsets[row + 1] - base, pick.bottom);
		}
	}
	ours.append(sourceHeight, height);
	theirs.append(sourceHeight, height);

	// Output emits all Current picks before Incoming. Reading back may move
	// up the source pane at that boundary, even to a second pick of the same row.
	const reverse = anchors();
	for (const pick of picks.values()) {
		const row = pick.row;
		if (row === undefined) continue;
		reverse.append(pick.top, model.offsets[row] - base);
		reverse.append(pick.bottom, model.offsets[row + 1] - base);
	}
	return {
		height,
		toOutput(side, y) {
			const map = side === "ours" ? ours : theirs;
			return mapOffset(map.side, map.output, y);
		},
		toSide: (y) => mapOffset(reverse.side, reverse.output, y),
	};
}

/** A pick only changes conflict geometry. Reuse folded/wrapped context until
 *  the source rows or Output width change. */
export function mergeScrollLayouts(
	model: SideRows,
	regions: readonly MergeRegion[],
	columns: number,
) {
	const layouts = regions.map((region, index) => {
		if (region.type === "conflict")
			return (taken: ReadonlySet<string>) =>
				conflictScroll(model, index, region, columns, taken);
		const fixed = contextScroll(model, index, region.mergedLines, columns);
		return () => fixed;
	});
	return (taken: ReadonlySet<string>) => {
		const maps = layouts.map((layout) => layout(taken));
		const output = layoutFrom(maps.map((map) => map.height));
		const source = model.regionTops;
		return {
			toOutput(side: MergeSide, y: number) {
				const i = regionAt(source, y);
				return (
					output[i] + (maps[i]?.toOutput(side, y - source[i]) ?? y - source[i])
				);
			},
			toSide(y: number) {
				const i = regionAt(output, y);
				return source[i] + (maps[i]?.toSide(y - output[i]) ?? y - output[i]);
			},
		};
	};
}
