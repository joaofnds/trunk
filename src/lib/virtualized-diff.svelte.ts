/**
 * The virtualization plumbing all three diff views share: the font-metrics
 * probe, the pane ResizeObserver, the readiness gate,
 * and the width/height arithmetic. One factory call per view; the view keeps
 * model building, the list binding, nav/flash and its template, and reads every
 * output through the returned object — destructuring an output severs
 * reactivity and is forbidden.
 *
 * The factory registers `onMount` and a `$effect`, so it must be called during
 * component init. The view `bind:this`es the pane and metrics probe.
 */
import { onMount, tick, untrack } from "svelte";
import { adjacentStop, type DiffNav, type StopJump } from "./diff-nav.js";
import {
	type ComposerPlace,
	changeRunEnd,
	type DiffRowModel,
	type ReadingLine,
	readingLineAt,
	rowHeights,
	rowIndexForLine,
	rowIndexForReadingLine,
	rowIndexForThread,
	stepRows,
} from "./diff-rows.js";
import type { ThreadReadingPosition } from "./diff-thread-position.js";
import { measure } from "./perf.js";
import { RowFlash } from "./row-flash.svelte.js";
import {
	availableCharsFor,
	measureRowMetrics,
	type RowMetrics,
} from "./row-metrics.js";
import { getScheduler } from "./scheduler.js";
import type { ContentMode, Side } from "./types.js";

// Tailwind's preflight sets tab-size: 4 globally, so a tab advances four
// columns — unless invisibles are on, where .invisible-char collapses it to one.
export const TAB_SIZE = 4;

// Horizontal room an inline row spends on something other than columns: 8px
// padding each side, the 3px change-indicator border, and the 8px gap after
// each of the two gutters. Erring high shortens the wrap point, which
// over-predicts a wrapped row's height — the safe direction.
const ROW_CHROME_PX = 35;
// The gap after one gutter, which a row with a single number column spends once.
const GUTTER_GAP_PX = 8;

// Horizontal room ONE HALF spends on something other than columns: 8px padding
// each side, the 3px change-indicator border, the 8px gap after this half's one
// gutter, and the 1px divider between the halves. The inline views spend two
// gutter gaps here; a split half has one.
const SPLIT_ROW_CHROME_PX = 28;

export interface DiffListHandle {
	isReady(): boolean;
	readingThread(): ThreadReadingPosition | null;
	restoreThread(position: ThreadReadingPosition): boolean;
	preservePosition(update: () => void): void;
	topIndex(): number;
	verticalScrollRevision(): number;
	anchorTo(index: number): void;
	revealIndex(index: number): void;
	revealSearchRow(
		index: number,
		onrevealed?: (mark: HTMLElement) => void,
	): void;
	scrollToIndex(index: number, onsettled?: () => void): void;
}

export interface ReadingAnchor {
	readonly line: ReadingLine | null;
	readonly thread?: ThreadReadingPosition | null;
}

export interface VirtualizedDiffDeps {
	model: () => DiffRowModel;
	wordWrap: () => boolean;
	composer: () => ComposerPlace | undefined;
	list: () => DiffListHandle | null;
	/** Where the list opens: a reading line or the top. Applied once per value. */
	startAt: () => ReadingAnchor | null;
	/** Whether the rows show hunks or the file whole, which decides what `]`
	 *  and `[` step between. */
	content: () => ContentMode;
}

export interface InlineVirtualizedDiffDeps extends VirtualizedDiffDeps {
	layout: "inline";
	/** The line-number columns a row draws: two for a change, the old number and
	 *  the new, and one for a file shown whole, whose numbers agree. */
	numberColumns: () => 1 | 2;
}

/** A split side draws one line-number column. */
export interface SplitVirtualizedDiffDeps extends VirtualizedDiffDeps {
	layout: "split";
}

export interface InlineVirtualizedDiff extends DiffNav {
	pane: HTMLDivElement | null;
	metricsProbe: HTMLDivElement | null;
	readonly metrics: RowMetrics | null;
	readonly paneWidthPx: number;
	readonly wrapActive: boolean;
	readonly availableColumns: number;
	readonly ready: boolean;
	readonly heights: (number | string)[];
	readonly contentWidth: string;
	readonly gutterW: string;
	readonly markerW: string;
	/** Whether row `index` is lit by the flash of the last jump. */
	flashLit(index: number): boolean;
}

export interface SplitVirtualizedDiff extends InlineVirtualizedDiff {
	readonly maxLeftPx: number;
	readonly maxRightPx: number;
}

// The pan ceilings exist only under the split layout: a zero-valued ceiling
// that compiles under inline would be a silently wrong number, so the overload
// makes reading one a type error instead.
export function createVirtualizedDiff(
	deps: InlineVirtualizedDiffDeps,
): InlineVirtualizedDiff;
export function createVirtualizedDiff(
	deps: SplitVirtualizedDiffDeps,
): SplitVirtualizedDiff;
export function createVirtualizedDiff(
	deps: InlineVirtualizedDiffDeps | SplitVirtualizedDiffDeps,
): SplitVirtualizedDiff {
	const split = deps.layout === "split";

	const state = $state({
		pane: null as HTMLDivElement | null,
		metricsProbe: null as HTMLDivElement | null,
		metrics: null as RowMetrics | null,
		paneWidthPx: 0,
	});

	const model = $derived(deps.model());

	// A proportional font makes column arithmetic meaningless, so wrapping is
	// refused rather than rendered at a height nothing can derive (P-8).
	const wrapActive = $derived(
		deps.wordWrap() && (state.metrics?.monospace ?? false),
	);

	// Inline wraps into the full pane less two gutters; a split side has half
	// the pane and one gutter — what a single side actually has to wrap into.
	// Each layout's marker column sits beside its gutters, once per side.
	const numberColumns = $derived(
		deps.layout === "inline" ? deps.numberColumns() : 1,
	);
	const inlineGutterChars = $derived(
		numberColumns * model.gutterChars + model.markerChars,
	);
	const inlineChromePx = $derived(
		ROW_CHROME_PX - (2 - numberColumns) * GUTTER_GAP_PX,
	);
	const sideGutterChars = $derived(model.gutterChars + model.markerChars);

	const availableColumns = $derived.by(() => {
		const measured = state.metrics;
		if (!measured) return 0;

		return split
			? availableCharsFor(
					state.paneWidthPx / 2,
					sideGutterChars,
					SPLIT_ROW_CHROME_PX,
					measured,
				)
			: availableCharsFor(
					state.paneWidthPx,
					inlineGutterChars,
					inlineChromePx,
					measured,
				);
	});

	const ready = $derived(
		state.metrics !== null &&
			state.paneWidthPx > 0 &&
			(!wrapActive || availableColumns > 0),
	);
	const heights = $derived.by(() => {
		const measured = state.metrics;
		if (!ready || !measured) return [];

		return measure("diff.rowHeights", (observation) => {
			observation.attr("rows", model.rows.length);
			observation.attr("wrap", String(wrapActive));

			return rowHeights(model, measured, availableColumns, wrapActive);
		});
	});

	// Each side's FULL width: the gutter is pinned outside the translated
	// window, so a ceiling built from text columns alone would stop short of the
	// widest line's tail by the gutter plus this half's chrome.
	const maxLeftPx = $derived(
		state.metrics
			? (sideGutterChars + (model.columns[0] ?? 0)) *
					state.metrics.charWidthPx +
					SPLIT_ROW_CHROME_PX
			: 0,
	);
	const maxRightPx = $derived(
		state.metrics
			? (sideGutterChars + (model.columns[1] ?? 0)) *
					state.metrics.charWidthPx +
					SPLIT_ROW_CHROME_PX
			: 0,
	);

	// Computed, never measured: a virtual list never has the widest row mounted,
	// so measuring one would make the extent jump while scrolling (invariant 2).
	// In pixels rather than `ch`, because the content div sits outside the rows
	// and would resolve `ch` against the app font instead of the diff row's.
	// Split is the widest side plus one half, so the pan reaches that side's
	// last character: a half only ever shows 50cqi of it. A wrapped split view
	// must not pan at all.
	const contentWidth = $derived.by(() => {
		const measured = state.metrics;
		if (wrapActive || !measured) return "100%";

		return split
			? `calc(${Math.max(maxLeftPx, maxRightPx)}px + 50cqi)`
			: `${(inlineGutterChars + (model.columns[0] ?? 0)) * measured.charWidthPx + inlineChromePx}px`;
	});

	const gutterW = $derived(`${model.gutterChars}ch`);
	const markerW = $derived(`${model.markerChars}ch`);

	onMount(() => {
		if (state.metricsProbe) {
			state.metrics = measureRowMetrics(state.metricsProbe);
		}

		const el = state.pane;
		if (!el) return;

		state.paneWidthPx = el.clientWidth;

		const observer = new ResizeObserver(() => {
			const width = el.clientWidth;
			if (width === state.paneWidthPx) return;

			const list = deps.list();
			if (wrapActive && list) {
				list.preservePosition(() => {
					state.paneWidthPx = width;
				});
			} else state.paneWidthPx = width;
		});
		observer.observe(el);

		return () => observer.disconnect();
	});

	// Keyed on where the composer sits rather than on the place object, which is
	// rebuilt whenever its owner re-derives: a reader who scrolled away from an
	// open composer is not pulled back to it.
	let revealedComposer: string | null = null;
	$effect(() => {
		const place = deps.composer();
		const list = deps.list();
		if (!place) {
			revealedComposer = null;
			return;
		}
		if (!list?.isReady()) return;

		const key = `${place.path}:${place.side}:${place.endLine}:${place.wholeFile ?? false}`;
		if (key === revealedComposer) return;

		revealedComposer = key;
		const index = untrack(() =>
			model.rows.findIndex((row) => row.kind === "composer"),
		);
		if (index >= 0) list.revealIndex(index);
	});

	// Keyed on the value's identity: the host hands over a new one each time a
	// view replaces another, and a list that reaches readiness late still opens
	// where the reader was rather than wherever it was scrolled since.
	let appliedStart: ReadingAnchor | null = null;
	$effect(() => {
		const start = deps.startAt();
		const list = deps.list();
		if (!start || start === appliedStart || !list?.isReady()) return;

		appliedStart = start;
		void tick().then(() => {
			if (list !== deps.list() || start !== deps.startAt()) return;
			if (start.thread && list.restoreThread(start.thread)) return;

			const line = start.line;
			const index = line ? rowIndexForReadingLine(model, line) : 0;
			if (index >= 0) list.anchorTo(index);
		});
	});

	// The reading line as of the last frame drawn, kept rather than computed on
	// request: a host asks while replacing this view, by when the inputs may
	// already be the next view's, and the split view rebuilds its rows for a new
	// content mode over the old one's payload, which puts another line at the top.
	let drawnLine: ReadingLine | null = null;

	// Wrapping changes every row's height but never which rows there are, so the
	// first frame drawn under the other wrap puts the row that was at the top back
	// there rather than show another one at the old scroll offset.
	let drawnTop: {
		index: number;
		wrap: boolean;
		thread: ThreadReadingPosition | null;
	} | null = null;
	$effect(() => {
		const list = deps.list();
		if (!list?.isReady()) return;

		if (drawnTop && drawnTop.wrap !== wrapActive) {
			if (!(drawnTop.thread && list.restoreThread(drawnTop.thread)))
				list.anchorTo(drawnTop.index);
		}

		const top = list.topIndex();
		drawnTop = { index: top, wrap: wrapActive, thread: list.readingThread() };
		drawnLine = readingLineAt(model, top);
	});

	// Derived rather than built with the rows, and so computed only when a step
	// reads it.
	const steps = $derived(stepRows(model, deps.content()));

	// Tied to the rows it was taken over: a refetch rebuilds them, and the step
	// at an ordinal of the old rows is not the step at that ordinal now.
	let lastJump:
		| (StopJump & {
				model: DiffRowModel;
				list: DiffListHandle;
				scrollRevision: number;
		  })
		| null = null;

	// A jump lights a hunk's header while the rows show hunks. A file shown
	// whole has no headers, so a step there lights the run of changed lines it
	// lands on instead.
	const flash = new RowFlash(getScheduler());
	onMount(() => () => flash.stop());

	function flashHeader(ordinal: number): void {
		const nav = model.hunkNav[ordinal];
		if (nav && deps.content() === "hunk") {
			flash.show(nav.rowIndex, nav.rowIndex + 1);
		}
	}

	function ordinalOf(path: string, hunkIdx: number): number {
		return model.hunkNav.findIndex(
			(entry) => entry.path === path && entry.hunkIdx === hunkIdx,
		);
	}

	function scrollToHunk(ordinal: number): void {
		const nav = model.hunkNav[ordinal];
		if (!nav) return;

		deps.list()?.scrollToIndex(nav.rowIndex);
		flashHeader(ordinal);
	}

	return {
		searchRows() {
			return model.rows;
		},
		revealSearchRow(index, onrevealed) {
			deps.list()?.revealSearchRow(index, onrevealed);
		},
		isReady() {
			return ready && (deps.list()?.isReady() ?? false);
		},
		readingLine() {
			return drawnLine;
		},
		readingThread() {
			return deps.list()?.readingThread() ?? null;
		},
		ordinalOf,
		scrollToHunk,
		scrollToLine(path, hunkIdx, lineIdx) {
			const rowIndex = rowIndexForLine(model, path, hunkIdx, lineIdx);
			if (rowIndex < 0) {
				scrollToHunk(ordinalOf(path, hunkIdx));
				return;
			}

			deps.list()?.scrollToIndex(rowIndex);
			flashHeader(ordinalOf(path, hunkIdx));
		},
		scrollToThread(path: string, side: Side, startLine: number) {
			const rowIndex = rowIndexForThread(model, path, side, startLine);
			if (rowIndex < 0) return false;

			deps.list()?.scrollToIndex(rowIndex);
			return true;
		},
		step(direction) {
			const list = deps.list();
			if (!list) return;

			const precedingJump =
				lastJump?.model === model &&
				lastJump.list === list &&
				lastJump.scrollRevision === list.verticalScrollRevision()
					? lastJump
					: null;
			const ordinal = adjacentStop(
				steps,
				list.topIndex(),
				direction,
				precedingJump,
			);
			if (ordinal < 0) return;

			const start = steps[ordinal];
			list.scrollToIndex(start, () => {
				flash.show(
					start,
					deps.content() === "hunk" ? start + 1 : changeRunEnd(model, start),
				);
				lastJump = {
					ordinal,
					top: list.topIndex(),
					model,
					list,
					scrollRevision: list.verticalScrollRevision(),
				};
			});
		},
		flashLit(index) {
			return flash.lit(index);
		},
		get pane() {
			return state.pane;
		},
		set pane(el) {
			state.pane = el;
		},
		get metricsProbe() {
			return state.metricsProbe;
		},
		set metricsProbe(el) {
			state.metricsProbe = el;
		},
		get metrics() {
			return state.metrics;
		},
		get paneWidthPx() {
			return state.paneWidthPx;
		},
		get wrapActive() {
			return wrapActive;
		},
		get availableColumns() {
			return availableColumns;
		},
		get ready() {
			return ready;
		},
		get heights() {
			return heights;
		},
		get contentWidth() {
			return contentWidth;
		},
		get gutterW() {
			return gutterW;
		},
		get markerW() {
			return markerW;
		},
		get maxLeftPx() {
			return maxLeftPx;
		},
		get maxRightPx() {
			return maxRightPx;
		},
	};
}
