import { COLUMN_PADDING_X } from "./graph-constants.js";
import { WIDEST_LABELS } from "./relative-time.js";
import type { ColumnWidths } from "./store.js";
import type { GraphCommit } from "./types.js";

export type MeasureText = (text: string, font: string) => number;

// Fonts the cells actually render in — the measurement is only as good as the
// font string it is taken with.
const HEADER_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const AUTHOR_CONTENT_FONT = "12px ui-sans-serif, system-ui, sans-serif";
const DATE_CONTENT_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const SHA_CONTENT_FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";

/** The author cell reserves the initials avatar (diameter + gap) before the name. */
export const AUTHOR_AVATAR_WIDTH = 18 + 8;

const CELL_PAD = 2 * COLUMN_PADDING_X;
/** 2× for the CSS padding, 2× so a header never touches its divider. */
const HEADER_PAD = 4 * COLUMN_PADDING_X;

const HEADER_LABELS: Record<keyof ColumnWidths, string> = {
	ref: "Branch/Tag",
	graph: "Graph",
	diff: "Diff",
	author: "Author",
	date: "Date",
	sha: "SHA",
};

/** The narrowest each column may be dragged: its own header, still readable. */
export function headerMinWidths(
	measure: MeasureText,
): Record<keyof ColumnWidths, number> {
	const mins = {} as Record<keyof ColumnWidths, number>;
	for (const [column, label] of Object.entries(HEADER_LABELS)) {
		mins[column as keyof ColumnWidths] =
			measure(label, HEADER_FONT) + HEADER_PAD;
	}
	return mins;
}

/**
 * Width the author column needs for this page of commits, or 0 when the page
 * holds nothing to measure. Callers keep the running maximum across pages.
 */
export function authorContentWidth(
	commits: GraphCommit[],
	measure: MeasureText,
): number {
	let widest = 0;
	for (const commit of commits) {
		if (commit.oid === "__wip__" || commit.is_stash) continue;
		const width =
			measure(commit.author_name, AUTHOR_CONTENT_FONT) +
			CELL_PAD +
			AUTHOR_AVATAR_WIDTH;
		if (width > widest) widest = width;
	}
	return widest;
}

/**
 * The date cell holds a relative label that changes as the commit ages, so the
 * column is sized for the widest label the clock can produce. Sizing it to the
 * labels currently on screen makes the column jump a minute later.
 */
export function dateContentWidth(measure: MeasureText): number {
	const widest = Math.max(
		...WIDEST_LABELS.map((label) => measure(label, DATE_CONTENT_FONT)),
	);
	return widest + CELL_PAD;
}

export function shaContentWidth(measure: MeasureText): number {
	return measure("0000000", SHA_CONTENT_FONT) + CELL_PAD;
}

/** Width that shows every lane, never narrower than the header needs. */
export function graphTargetWidth(
	maxColumns: number,
	laneWidth: number,
	headerMin: number,
): number {
	const fitWidth = Math.max(maxColumns, 1) * laneWidth + CELL_PAD;
	return Math.max(fitWidth, headerMin);
}
