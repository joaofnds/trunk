import {
	COLUMN_PADDING_X,
	DEFAULT_GRAPH_SETTINGS,
	ICON_GAP,
	ICON_WIDTH,
	LANE_WIDTH,
	MESSAGE_MIN_WIDTH,
	PILL_FONT,
	PILL_FONT_BOLD,
	PILL_GAP,
	PILL_MARGIN_LEFT,
	PILL_PADDING_X,
} from "./graph-constants.js";
import { overflowBadgeWidth, sortRefs } from "./ref-pill-data.js";
import { WIDEST_LABELS } from "./relative-time.js";
import type { GraphCommit, GraphDisplaySettings } from "./types.js";

export interface ColumnWidths {
	ref: number;
	graph: number;
	diff: number;
	author: number;
	date: number;
	sha: number;
	// message is flex-1, no fixed width
}

export const DEFAULT_WIDTHS: ColumnWidths = {
	ref: 120,
	graph: 24,
	diff: 96,
	author: 60,
	date: 40,
	sha: 50,
};

/**
 * The widest auto-fit may make a column on its own. A drag is not bound by it:
 * the user asking for a width is the one case where a width needs no defending.
 */
export const MAX_AUTOFIT_WIDTH = 400;

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
/** Size of the icon a header falls back to when its word no longer fits. */
export const HEADER_ICON_WIDTH = 12;
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

/** The width below which a header shows its icon instead of its word. */
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
 * The narrowest each column may be dragged. Sized for the cell's content, never
 * for the header word: a header too narrow for its word shows an icon, so the
 * word cannot be what stops the drag. The graph's floor is one lane, which is
 * the single line of commits the column exists to show.
 */
export function columnFloors(): Record<keyof ColumnWidths, number> {
	return {
		ref: HEADER_ICON_WIDTH + CELL_PAD,
		graph: LANE_WIDTH + CELL_PAD,
		diff: HEADER_ICON_WIDTH + CELL_PAD,
		author: HEADER_ICON_WIDTH + CELL_PAD,
		date: HEADER_ICON_WIDTH + CELL_PAD,
		sha: HEADER_ICON_WIDTH + CELL_PAD,
	};
}

/** Whether a header of this width has room for its word rather than its icon. */
export function showsHeaderLabel(width: number, labelMin: number): boolean {
	return width >= labelMin;
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

/** Width that shows every lane. */
export function graphTargetWidth(
	maxColumns: number,
	laneWidth: number,
): number {
	return Math.max(maxColumns, 1) * laneWidth + CELL_PAD;
}

/**
 * Width the ref column needs to show this page's widest pill in full, or 0 when
 * the page carries no refs. Inverts the geometry `buildRefPillData` uses to
 * decide how much text room a pill has, so a column at this width truncates
 * nothing. Callers keep the running maximum across pages, as the author column does.
 */
export function refContentWidth(
	commits: GraphCommit[],
	measure: MeasureText,
	settings: GraphDisplaySettings = DEFAULT_GRAPH_SETTINGS,
): number {
	const dotInset = settings.laneWidth / 2 - settings.dotRadius;
	const chrome =
		PILL_MARGIN_LEFT +
		COLUMN_PADDING_X +
		dotInset +
		2 * PILL_PADDING_X +
		ICON_WIDTH +
		ICON_GAP;

	let widest = 0;
	for (const commit of commits) {
		if (commit.oid === "__wip__" || commit.is_stash) continue;
		if (commit.refs.length === 0) continue;

		// A row shows its highest-priority ref and folds the rest into a "+N"
		// badge, so that pill is the one to fit, and it shares the row with the
		// badge. Sizing for the label alone truncated it by the badge's width.
		const [primary] = sortRefs(commit.refs);
		const badge = overflowBadgeWidth(commit.refs.length - 1);
		const width =
			measure(
				primary.short_name,
				primary.is_head ? PILL_FONT_BOLD : PILL_FONT,
			) +
			chrome +
			(badge > 0 ? PILL_GAP + badge : 0);

		if (width > widest) widest = width;
	}

	return widest;
}

/**
 * The stored layout, made safe to lay out with. The pref file is plain JSON that
 * nothing upstream validates, and a width that is not a usable number reached the
 * drag clamp as NaN, which persisted itself and left the column unresizable.
 *
 * A width that is merely large is not unsafe. Only the floor is enforced, so a
 * width the user dragged comes back as they left it however wide that was.
 */
export function sanitizeColumnWidths(
	stored: Partial<ColumnWidths> | null | undefined,
): ColumnWidths {
	const floors = columnFloors();
	const widths = {} as ColumnWidths;

	for (const column of Object.keys(DEFAULT_WIDTHS) as (keyof ColumnWidths)[]) {
		const value = stored?.[column];
		widths[column] =
			typeof value === "number" && Number.isFinite(value) && value > 0
				? Math.max(floors[column], Math.round(value))
				: DEFAULT_WIDTHS[column];
	}

	return widths;
}

/**
 * How wide the header and every row must be laid out, given the space the list
 * has. Normally that is the container: the message column absorbs the slack and
 * the row fits. Once the sized columns leave message less than its floor, the
 * row is wider than the container and the difference is what scrolls, which is
 * the only way a column dragged past the right edge stays reachable.
 */
export function tableOverflowWidth(
	widths: ColumnWidths,
	visible: Record<keyof ColumnWidths | "message", boolean>,
	containerWidth: number,
): number {
	let sized = 0;
	for (const column of Object.keys(widths) as (keyof ColumnWidths)[]) {
		if (visible[column]) sized += widths[column];
	}

	const messageFloor = visible.message ? MESSAGE_MIN_WIDTH : 0;

	return Math.max(containerWidth, sized + messageFloor);
}
