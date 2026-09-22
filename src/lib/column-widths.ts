import {
	COLUMN_PADDING_X,
	DEFAULT_GRAPH_SETTINGS,
	ICON_GAP,
	ICON_WIDTH,
	LANE_WIDTH,
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

/** Every column with a width of its own, which is every column but Message. */
export const SIZED_COLUMNS: readonly (keyof ColumnWidths)[] = Object.keys(
	DEFAULT_WIDTHS,
) as (keyof ColumnWidths)[];

export function isSizedColumn(name: unknown): name is keyof ColumnWidths {
	return typeof name === "string" && Object.hasOwn(DEFAULT_WIDTHS, name);
}

/**
 * The custom property on the commit list's root that holds a column's width.
 * Header cells and row cells both read it, so neither can keep a width of its own.
 */
export function columnWidthProperty(column: keyof ColumnWidths): string {
	return `--column-${column}-width`;
}

/** The commit list root's style: every sized column's width, declared once. */
export function columnWidthDeclarations(widths: ColumnWidths): string {
	return (Object.keys(DEFAULT_WIDTHS) as (keyof ColumnWidths)[])
		.map((column) => `${columnWidthProperty(column)}: ${widths[column]}px;`)
		.join(" ");
}

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

/**
 * The narrowest Message may be squeezed to. It has no width of its own and takes
 * what the sized columns leave, so without a floor a narrow list drives the commit
 * subject, the column worth reading, to nothing.
 */
export const MESSAGE_FLOOR = 180;

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
 * The most a fit may claim on its own. A user width is never held to it, and
 * Graph's cap is a share of the row rather than a pixel count.
 */
export const FIT_CAPS = { ref: 240, author: 160 } as const;

/** Graph fits at most this share of the row, the cap Git Graph's auto layout uses. */
const GRAPH_CAP_SHARE = 1 / 3;

/**
 * The order fits give up width in when together they overrun the budget:
 * rightmost first, with Diff ahead of Date and Author because its bar scales and
 * loses no text while theirs are cut, and Branch/Tag ahead of Graph because a cut
 * pill's name is a hover away while a lane past the edge is not.
 */
const YIELD_ORDER: readonly (keyof ColumnWidths)[] = [
	"sha",
	"diff",
	"date",
	"author",
	"ref",
	"graph",
];

export interface BudgetRequest {
	/** What each column's fit asks for, before its cap. */
	wanted: ColumnWidths;
	/** The columns the app lays out: shown, and not carrying a user width. */
	fitted: readonly (keyof ColumnWidths)[];
	/** The width the row lays its cells out in, 0 while the list is unmeasured. */
	rowWidth: number;
	/** The part of the row the fits may not use: user widths and Message's floor. */
	reserved: number;
}

/**
 * The widths of the fitted columns. Each takes its fit up to its cap, and when
 * together they overrun the budget they yield toward their floors in
 * YIELD_ORDER, so a layout the app chose fits the list whenever the list has
 * room for the floors. An unmeasured list has no budget, and only the pixel
 * caps apply.
 */
export function shareBudget(request: BudgetRequest): Partial<ColumnWidths> {
	const { wanted, fitted, rowWidth, reserved } = request;
	const floors = columnFloors();
	const caps = fitCaps(rowWidth);
	const widths: Partial<ColumnWidths> = {};

	for (const column of fitted) {
		widths[column] = Math.max(
			floors[column],
			Math.min(caps[column], wanted[column]),
		);
	}
	if (rowWidth <= 0) return widths;

	let overrun =
		Object.values(widths).reduce((sum, width) => sum + width, 0) -
		(rowWidth - reserved);
	for (const column of YIELD_ORDER) {
		const width = widths[column];
		if (overrun <= 0) break;
		if (width === undefined) continue;

		const given = Math.min(overrun, width - floors[column]);
		widths[column] = width - given;
		overrun -= given;
	}

	return widths;
}

function fitCaps(rowWidth: number): ColumnWidths {
	const uncapped = Number.POSITIVE_INFINITY;

	return {
		ref: FIT_CAPS.ref,
		graph: rowWidth > 0 ? Math.floor(rowWidth * GRAPH_CAP_SHARE) : uncapped,
		diff: uncapped,
		author: FIT_CAPS.author,
		date: uncapped,
		sha: uncapped,
	};
}

/**
 * The stored layout, made safe to lay out with. The pref file is plain JSON that
 * nothing upstream validates, and a width that is not a usable number reached the
 * drag clamp as NaN, which persisted itself and left the column unresizable.
 * A width that is merely large is not unsafe: it is the user's to choose.
 */
export function sanitizeColumnWidths(stored: unknown): ColumnWidths {
	const floors = columnFloors();
	const record =
		typeof stored === "object" && stored !== null
			? (stored as Record<string, unknown>)
			: {};
	const widths = {} as ColumnWidths;

	for (const column of Object.keys(DEFAULT_WIDTHS) as (keyof ColumnWidths)[]) {
		const value = record[column];
		widths[column] =
			typeof value === "number" && Number.isFinite(value) && value > 0
				? Math.max(floors[column], Math.round(value))
				: DEFAULT_WIDTHS[column];
	}

	return widths;
}
