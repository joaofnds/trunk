/**
 * The virtualization plumbing all three diff views share: the font-metrics
 * probe, the pane ResizeObserver, the comment-height probe, the readiness gate,
 * and the width/height arithmetic. One factory call per view; the view keeps
 * model building, the list binding, nav/flash and its template, and reads every
 * output through the returned object — destructuring an output severs
 * reactivity and is forbidden.
 *
 * The factory registers `onMount` and a `$effect`, so it must be called during
 * component init. The view `bind:this`es the pane, the metrics probe and the
 * comment probe into the settable refs.
 */
import { onMount, tick, untrack } from "svelte";
import { adjacentStop, type StopJump } from "./diff-nav.js";
import {
	type ComposerPlace,
	type DiffRowModel,
	type ReadingLine,
	readingLineAt,
	rowHeights,
	rowIndexForReadingLine,
} from "./diff-rows.js";
import { measure } from "./perf.js";
import {
	availableCharsFor,
	measureRowMetrics,
	type RowMetrics,
} from "./row-metrics.js";
import { ThreadFolds } from "./thread-folds.svelte.js";
import type { Thread } from "./types.js";

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
	topIndex(): number;
	anchorTo(index: number): void;
	revealIndex(index: number): void;
}

export interface VirtualizedDiffDeps {
	model: () => DiffRowModel;
	wordWrap: () => boolean;
	composer: () => ComposerPlace | undefined;
	list: () => DiffListHandle | null;
	/** The line-number columns an inline row draws: two for a change, the old
	 *  number and the new, and one for a file shown whole, whose numbers agree.
	 *  Two when omitted. A split side draws one whatever this says. */
	numberColumns?: () => 1 | 2;
	/** The line the reader was at in the view this one replaced, which the list
	 *  opens at instead of the top. Applied once per value. */
	startAt?: () => ReadingLine | null;
}

export interface InlineVirtualizedDiff {
	pane: HTMLDivElement | null;
	metricsProbe: HTMLDivElement | null;
	commentProbe: HTMLDivElement | null;
	readonly metrics: RowMetrics | null;
	readonly paneWidthPx: number;
	readonly probedHeights: Map<string, number>;
	/** Shared by each row's card and its copy in the comment probe, so the height measured is the height drawn. */
	readonly folds: ThreadFolds;
	readonly wrapActive: boolean;
	readonly availableColumns: number;
	readonly threadsToProbe: Thread[];
	readonly ready: boolean;
	readonly heights: number[];
	readonly contentWidth: string;
	readonly gutterW: string;
	readonly markerW: string;
	/** The first line at the top of the list, the place a replacing view opens at. */
	readingLine(): ReadingLine | null;
	/** The hunk `]` (1) or `[` (-1) goes to from where the reader is, or -1. */
	adjacentHunk(direction: 1 | -1): number;
	/** Records that a jump just brought a hunk to the top, which the next step
	 *  goes on from while the reader leaves the view where it is. */
	noteHunkJump(ordinal: number): void;
}

export interface SplitVirtualizedDiff extends InlineVirtualizedDiff {
	readonly maxLeftPx: number;
	readonly maxRightPx: number;
}

// The pan ceilings exist only under the split layout: a zero-valued ceiling
// that compiles under inline would be a silently wrong number, so the overload
// makes reading one a type error instead.
export function createVirtualizedDiff(
	deps: VirtualizedDiffDeps & { layout: "inline" },
): InlineVirtualizedDiff;
export function createVirtualizedDiff(
	deps: VirtualizedDiffDeps & { layout: "split" },
): SplitVirtualizedDiff;
export function createVirtualizedDiff(
	deps: VirtualizedDiffDeps & { layout: "inline" | "split" },
): SplitVirtualizedDiff {
	const split = deps.layout === "split";

	const state = $state({
		pane: null as HTMLDivElement | null,
		metricsProbe: null as HTMLDivElement | null,
		commentProbe: null as HTMLDivElement | null,
		metrics: null as RowMetrics | null,
		paneWidthPx: 0,
		probedHeights: new Map<string, number>(),
	});
	const folds = new ThreadFolds();

	const model = $derived(deps.model());

	// A proportional font makes column arithmetic meaningless, so wrapping is
	// refused rather than rendered at a height nothing can derive (P-8).
	const wrapActive = $derived(
		deps.wordWrap() && (state.metrics?.monospace ?? false),
	);

	// Inline wraps into the full pane less two gutters; a split side has half
	// the pane and one gutter — what a single side actually has to wrap into.
	// Each layout's marker column sits beside its gutters, once per side.
	const numberColumns = $derived(deps.numberColumns?.() ?? 2);
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

	const threadsToProbe = $derived(
		model.rows.flatMap((row) => (row.kind === "comment" ? row.threads : [])),
	);

	// Invariant 8: withhold the list until every input exists, rather than render
	// against a default height and correct it afterwards.
	const ready = $derived(
		state.metrics !== null &&
			state.paneWidthPx > 0 &&
			threadsToProbe.every((thread) => state.probedHeights.has(thread.id)) &&
			(!wrapActive || availableColumns > 0),
	);

	const heights = $derived.by(() => {
		const measured = state.metrics;
		if (!ready || !measured) return [];

		return measure("diff.rowHeights", (observation) => {
			observation.attr("rows", model.rows.length);
			observation.attr("wrap", String(wrapActive));

			return rowHeights(
				model,
				measured,
				availableColumns,
				wrapActive,
				state.probedHeights,
			);
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
			const anchor = deps.list()?.topIndex() ?? 0;
			state.paneWidthPx = el.clientWidth;

			if (wrapActive) tick().then(() => deps.list()?.anchorTo(anchor));
		});
		observer.observe(el);

		return () => observer.disconnect();
	});

	$effect(() => {
		const container = state.commentProbe;
		const wanted = threadsToProbe;
		if (!container || wanted.length === 0) return;

		// Lay the probe out at the width the real rows occupy, and re-measure
		// whenever that width changes: a ThreadCard reflows, so a height taken at
		// another width is not this row's height (P-2's re-probe triggers).
		container.style.width = contentWidth;
		container.style.minWidth = `${state.paneWidthPx}px`;

		const rows = container.querySelectorAll<HTMLElement>(
			"[data-probe-thread-id]",
		);
		const remeasure = () => {
			const measured = heightsOf(rows);
			if (!wanted.every((thread) => measured.has(thread.id))) return;

			const known = untrack(() => state.probedHeights);
			if (!sameHeights(known, measured)) state.probedHeights = measured;
		};
		remeasure();

		// A card changes its own height when it folds, so the copy measured here
		// is watched for as long as it stands for its row.
		const observer = new ResizeObserver(remeasure);
		for (const row of rows) observer.observe(row);

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
		if (!list || !ready) return;

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
	let appliedStart: ReadingLine | null = null;
	$effect(() => {
		const start = deps.startAt?.() ?? null;
		const list = deps.list();
		if (!start || start === appliedStart || !list || !ready) return;

		appliedStart = start;
		const index = untrack(() => rowIndexForReadingLine(model, start));
		if (index >= 0) list.anchorTo(index);
	});

	// The reading line as of the last frame drawn, kept rather than computed on
	// request: a host asks while replacing this view, by when the inputs may
	// already be the next view's, and the split view rebuilds its rows for a new
	// content mode over the old one's payload, which puts another line at the top.
	let drawnLine: ReadingLine | null = null;
	$effect(() => {
		const list = deps.list();
		if (!list || !ready) return;

		drawnLine = readingLineAt(model, list.topIndex());
	});

	// Tied to the rows it was taken over: a refetch rebuilds them, and the hunk
	// at an ordinal of the old rows is not the hunk at that ordinal now.
	let lastJump: (StopJump & { model: DiffRowModel }) | null = null;

	return {
		folds,
		readingLine() {
			return drawnLine;
		},
		adjacentHunk(direction) {
			const list = deps.list();
			if (!list) return -1;

			return adjacentStop(
				model.hunkNav.map((entry) => entry.rowIndex),
				list.topIndex(),
				direction,
				lastJump?.model === model ? lastJump : null,
			);
		},
		noteHunkJump(ordinal) {
			const list = deps.list();
			lastJump = list ? { ordinal, top: list.topIndex(), model } : null;
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
		get commentProbe() {
			return state.commentProbe;
		},
		set commentProbe(el) {
			state.commentProbe = el;
		},
		get metrics() {
			return state.metrics;
		},
		get paneWidthPx() {
			return state.paneWidthPx;
		},
		get probedHeights() {
			return state.probedHeights;
		},
		get wrapActive() {
			return wrapActive;
		},
		get availableColumns() {
			return availableColumns;
		},
		get threadsToProbe() {
			return threadsToProbe;
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

function heightsOf(rows: Iterable<HTMLElement>): Map<string, number> {
	const measured = new Map<string, number>();
	for (const row of rows) {
		const id = row.dataset.probeThreadId;
		const height = row.offsetHeight;
		// A zero here is an unmeasured row, not a row of no height. Recording it
		// would be the substituted default invariant 8 forbids.
		if (id && height > 0) measured.set(id, height);
	}

	return measured;
}

function sameHeights(
	known: Map<string, number>,
	measured: Map<string, number>,
): boolean {
	if (known.size !== measured.size) return false;

	for (const [id, height] of measured) {
		if (known.get(id) !== height) return false;
	}

	return true;
}
