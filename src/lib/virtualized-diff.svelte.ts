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
import { onMount, tick } from "svelte";
import { type DiffRowModel, rowHeights } from "./diff-rows.js";
import { measure } from "./perf.js";
import {
	availableCharsFor,
	measureRowMetrics,
	type RowMetrics,
} from "./row-metrics.js";
import type { Thread } from "./types.js";

// Tailwind's preflight sets tab-size: 4 globally, so a tab advances four
// columns — unless invisibles are on, where .invisible-char collapses it to one.
export const TAB_SIZE = 4;

// Horizontal room an inline row spends on something other than columns: 8px
// padding each side, the 3px change-indicator border, and the 8px gap after
// each of the two gutters. Erring high shortens the wrap point, which
// over-predicts a wrapped row's height — the safe direction.
export const ROW_CHROME_PX = 35;

// Horizontal room ONE HALF spends on something other than columns: 8px padding
// each side, the 3px change-indicator border, the 8px gap after this half's one
// gutter, and the 1px divider between the halves. The inline views spend two
// gutter gaps here; a split half has one.
export const SPLIT_ROW_CHROME_PX = 28;

export interface VirtualizedDiffDeps {
	model: () => DiffRowModel;
	wordWrap: () => boolean;
	list: () => { topIndex(): number; anchorTo(index: number): void } | null;
}

export interface InlineVirtualizedDiff {
	pane: HTMLDivElement | null;
	metricsProbe: HTMLDivElement | null;
	commentProbe: HTMLDivElement | null;
	readonly metrics: RowMetrics | null;
	readonly paneWidthPx: number;
	readonly probedHeights: Map<string, number>;
	readonly wrapActive: boolean;
	readonly availableColumns: number;
	readonly threadsToProbe: Thread[];
	readonly ready: boolean;
	readonly heights: number[];
	readonly contentWidth: string;
	readonly gutterW: string;
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

	const model = $derived(deps.model());

	// A proportional font makes column arithmetic meaningless, so wrapping is
	// refused rather than rendered at a height nothing can derive (P-8).
	const wrapActive = $derived(
		deps.wordWrap() && (state.metrics?.monospace ?? false),
	);

	// Inline wraps into the full pane less two gutters; a split side has half
	// the pane and one gutter — what a single side actually has to wrap into.
	const availableColumns = $derived.by(() => {
		const measured = state.metrics;
		if (!measured) return 0;

		return split
			? availableCharsFor(
					state.paneWidthPx / 2,
					model.gutterChars,
					SPLIT_ROW_CHROME_PX,
					measured,
				)
			: availableCharsFor(
					state.paneWidthPx,
					2 * model.gutterChars,
					ROW_CHROME_PX,
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
			? (model.gutterChars + (model.columns[0] ?? 0)) *
					state.metrics.charWidthPx +
					SPLIT_ROW_CHROME_PX
			: 0,
	);
	const maxRightPx = $derived(
		state.metrics
			? (model.gutterChars + (model.columns[1] ?? 0)) *
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
			: `${(2 * model.gutterChars + (model.columns[0] ?? 0)) * measured.charWidthPx + ROW_CHROME_PX}px`;
	});

	const gutterW = $derived(`${model.gutterChars}ch`);

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

		const measured = new Map<string, number>();
		for (const row of container.querySelectorAll<HTMLElement>(
			"[data-thread-id]",
		)) {
			const id = row.dataset.threadId;
			const height = row.offsetHeight;
			// A zero here is an unmeasured row, not a row of no height. Recording it
			// would be the substituted default invariant 8 forbids.
			if (id && height > 0) measured.set(id, height);
		}

		if (wanted.every((thread) => measured.has(thread.id))) {
			state.probedHeights = measured;
		}
	});

	return {
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
		get maxLeftPx() {
			return maxLeftPx;
		},
		get maxRightPx() {
			return maxRightPx;
		},
	};
}
