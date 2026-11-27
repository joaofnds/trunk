<script lang="ts" generics="TItem">
import { flushSync, onMount, type Snippet, tick } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import {
	type ThreadReadingPosition,
	threadPositionAt,
	threadPositionTarget,
} from "../../lib/diff-thread-position.js";
import { revealDiffMatch } from "../../lib/reveal-diff-match.js";
import { buildOffsets, windowFor } from "../../lib/virtual-window.js";

interface Props {
	items: TItem[];
	/** A computed height or the stable key of a row with intrinsic height. */
	heights: (number | string)[];
	/** CSS width of the scrollable content, computed rather than measured. */
	contentWidth: string;
	/** Space after the last row, for what hangs below it. */
	trailingSpace: number;
	horizontal?: boolean;
	/** Runway either side, in pixels. Defaults to one viewport height. */
	overscanPx?: number;
	renderItem: Snippet<[TItem, number]>;
}

let {
	items,
	heights,
	contentWidth,
	trailingSpace,
	horizontal = true,
	overscanPx,
	renderItem,
}: Props = $props();

let viewport = $state<HTMLDivElement | null>(null);
let rows = $state<HTMLDivElement | null>(null);
let scrollTop = $state(0);
let scrollRevision = 0;
// Published once, on the rows container, as the `--pan-x` every row's own
// transform reads, so a horizontal scroll re-renders no row.
let panLeft = $state(0);
let viewportHeight = $state(0);
let lastExtent = $state(0);

type Section =
	| { kind: "run"; key: string; start: number; end: number }
	| { kind: "measured"; key: string; index: number };

const measured = new SvelteMap<string, number>();
const sections = $derived.by(() => {
	const result: Section[] = [];
	let start = 0;
	let previous = "";
	for (let index = 0; index < heights.length; index++) {
		const height = heights[index];
		if (typeof height === "number") continue;

		if (start < index)
			result.push({ kind: "run", key: `run:${previous}`, start, end: index });
		result.push({ kind: "measured", key: height, index });
		start = index + 1;
		previous = height;
	}
	if (result.length > 0 && start < heights.length) {
		result.push({
			kind: "run",
			key: `run:${previous}`,
			start,
			end: heights.length,
		});
	}
	return result;
});

const dimensions = $derived.by(() => {
	let ready = true;
	const values = heights.map((height) => {
		if (typeof height === "number") return height;
		const value = measured.get(height);
		if (value === undefined) ready = false;
		return value ?? 0;
	});
	return { offsets: buildOffsets(values), ready };
});
const offsets = $derived(dimensions.offsets);
const contentHeight = $derived(
	dimensions.ready
		? items.length > 0
			? offsets[items.length] + trailingSpace
			: 0
		: lastExtent,
);
const runway = $derived(overscanPx ?? viewportHeight);
const renderedScrollTop = $derived(
	Math.max(0, Math.min(scrollTop, Math.max(0, contentHeight - viewportHeight))),
);
const shown = $derived(
	windowFor(offsets, renderedScrollTop, viewportHeight, runway),
);
const visible = $derived(items.slice(shown.start, shown.end));

const measuredRows = new Map<Element, string>();
const measuredIndexes = $derived(
	new Map(
		sections.flatMap((section) =>
			section.kind === "measured"
				? [[section.key, section.index] as const]
				: [],
		),
	),
);
let rowObserver: ResizeObserver | null = null;

interface ElementAnchor {
	element: Element;
	offset: number;
}

interface ScrollAnchor {
	index: number;
	offset: number;
	element: ElementAnchor | null;
}

interface Navigation {
	items: TItem[];
	index: number;
	reveal: boolean;
	onsettled?: () => void;
}

let elementAnchor: ElementAnchor | null = null;
let focusAnchor: ElementAnchor | null = null;
let threadPosition: ThreadReadingPosition | null = null;
let navigation = $state.raw<Navigation | null>(null);

function rememberPosition() {
	elementAnchor = null;
	focusAnchor = null;
	threadPosition = null;
	if (!viewport || !dimensions.ready || measuredRows.size === 0) return;

	const index = windowFor(offsets, renderedScrollTop, viewportHeight, 0).start;
	const key = heights[index];
	const row =
		typeof key === "string"
			? rows?.querySelector(`[data-measured-row="${CSS.escape(key)}"]`)
			: null;
	const active = document.activeElement;
	const focused =
		active && viewport.contains(active) && active.closest("[data-measured-row]")
			? active
			: null;
	if (!row && !focused) return;

	const top = viewport.getBoundingClientRect().top;
	const reading = row && threadPositionAt(row, top);
	if (reading) {
		threadPosition = reading.position;
		elementAnchor = {
			element: reading.element,
			offset: reading.position.offset,
		};
	}

	if (focused) {
		const rect = focused.getBoundingClientRect();
		if (rect.bottom > top && rect.top < top + viewportHeight) {
			focusAnchor = { element: focused, offset: top - rect.top };
		}
	}
}

$effect(() => {
	if (dimensions.ready) lastExtent = contentHeight;
	rememberPosition();
});

function remeasureRows(entries: ResizeObserverEntry[]) {
	const changes = new Map<string, number>();
	for (const entry of entries) {
		const key = measuredRows.get(entry.target);
		if (key !== undefined)
			addMeasurement(changes, key, entry.borderBoxSize[0].blockSize);
	}
	if (changes.size === 0) return;

	const anchor = captureScrollAnchor();
	const top = viewport?.scrollTop ?? scrollTop;
	flushSync(() => {
		publishMeasurements(changes);
		if (!anchor) recordScrollTop(top);
	});
	if (anchor) restoreScrollAnchor(anchor);
}

function captureScrollAnchor(): ScrollAnchor | null {
	if (!viewport || !dimensions.ready || viewport.scrollTop !== scrollTop)
		return null;

	const index = topIndex();
	const active =
		focusAnchor?.element === document.activeElement ? focusAnchor : null;
	return {
		index,
		offset: scrollTop - offsets[index],
		element: active ?? elementAnchor,
	};
}

function restoreScrollAnchor(anchor: ScrollAnchor): void {
	const target = anchor.element;
	const top =
		target && rows?.contains(target.element)
			? documentTop(target.element) + target.offset
			: offsets[anchor.index] + anchor.offset;
	setScrollTop(top);
	if (
		target?.element instanceof HTMLElement &&
		target.element === document.activeElement
	) {
		void revealFocused(target.element);
	}
}

function addMeasurement(
	changes: Map<string, number>,
	key: string,
	height: number,
): void {
	if (height > 0 && height !== measured.get(key)) changes.set(key, height);
}

function publishMeasurements(changes: Map<string, number>): void {
	for (const [key, height] of changes) measured.set(key, height);
}

// The observer reports before paint. A jump can be requested first, after a
// control or a refetch has already changed the row's DOM.
function syncMeasuredRows(): void {
	const changes = new Map<string, number>();
	for (const [node, key] of measuredRows) {
		addMeasurement(changes, key, node.getBoundingClientRect().height);
	}
	if (changes.size === 0) return;

	flushSync(() => publishMeasurements(changes));
}

function measureRow(node: HTMLDivElement, key: string) {
	rowObserver ??= new ResizeObserver(remeasureRows);
	const observer = rowObserver;
	measuredRows.set(node, key);

	const { height } = node.getBoundingClientRect();
	if (height > 0) measured.set(key, height);
	observer.observe(node, { box: "border-box" });

	return {
		destroy() {
			observer.unobserve(node);
			measuredRows.delete(node);
			measured.delete(key);
		},
	};
}

onMount(() => {
	const el = viewport;
	if (!el) return;

	const measure = () => {
		const height = el.clientHeight;
		if (height === viewportHeight) return;

		const active = focusAnchor?.element;
		viewportHeight = height;
		if (active instanceof HTMLElement && active === document.activeElement) {
			void revealFocused(active);
		}
	};

	measure();
	const observer = new ResizeObserver(measure);
	observer.observe(el);

	return () => observer.disconnect();
});

/** Index of the row at the top of the viewport, for a caller about to change
 *  the heights and wanting the reader to keep their place. */
export function topIndex(): number {
	return windowFor(offsets, scrollTop, viewportHeight, 0).start;
}

export function isReady(): boolean {
	return dimensions.ready;
}

export function readingThread(): ThreadReadingPosition | null {
	return threadPosition;
}

export function restoreThread(position: ThreadReadingPosition): boolean {
	const target = rows && threadPositionTarget(rows, position);
	if (!target) return false;

	setScrollTop(documentTop(target) + position.offset);
	return true;
}

export function verticalScrollRevision(): number {
	return scrollRevision;
}

function recordScrollTop(top: number): void {
	if (top === scrollTop) return;

	scrollTop = top;
	scrollRevision++;
}

export function scrollToIndex(index: number, onsettled?: () => void): void {
	navigate(index, false, onsettled);
}

function navigate(
	index: number,
	reveal: boolean,
	onsettled?: () => void,
): void {
	if (!viewport || items.length === 0) return;

	const request = { items, index, reveal, onsettled };
	if (sections.length === 0) applyNavigation(request);
	else navigation = request;
}

$effect(() => {
	const request = navigation;
	if (!request || !dimensions.ready) return;

	void tick().then(() => {
		if (request !== navigation) return;
		navigation = null;
		if (!viewport || items !== request.items) return;

		syncMeasuredRows();
		applyNavigation(request);
	});
});

function applyNavigation(request: Navigation): void {
	const index = Math.max(0, Math.min(request.index, items.length - 1));
	if (request.reveal) reveal(offsets[index], offsets[index + 1]);
	else setScrollTop(offsets[index]);
	request.onsettled?.();
}

export function preservePosition(update: () => void): void {
	const anchor = captureScrollAnchor();
	const revision = scrollRevision;
	update();
	if (!anchor) return;

	void tick().then(() => {
		if (!viewport || revision !== scrollRevision) return;

		syncMeasuredRows();
		restoreScrollAnchor(anchor);
	});
}

/** Scrolls the least distance that shows the whole row, and not at all when it
 *  already shows. */
export function revealIndex(index: number): void {
	navigate(index, true);
}

export function revealSearchRow(
	index: number,
	onrevealed?: (mark: HTMLElement) => void,
): void {
	navigate(index, true, () => {
		void tick().then(() => {
			const mark = rows?.querySelector<HTMLElement>("[data-diff-match]");
			const scroller = viewport;
			if (!scroller || !mark) return;

			revealDiffMatch(mark);
			// A second Find step can arrive before the native scroll event.
			flushSync(() => {
				recordScrollTop(scroller.scrollTop);
				panLeft = scroller.scrollLeft;
			});
			onrevealed?.(mark);
		});
	});
}

function reveal(top: number, bottom: number): void {
	if (top < scrollTop) {
		setScrollTop(top);
	} else if (bottom > scrollTop + viewportHeight) {
		setScrollTop(Math.min(top, bottom - viewportHeight));
	}
}

function setScrollTop(top: number): void {
	if (!viewport) return;

	if (top !== viewport.scrollTop) viewport.scrollTop = top;
	recordScrollTop(viewport.scrollTop);
}

function documentTop(element: Element): number {
	return (
		element.getBoundingClientRect().top -
		(rows?.getBoundingClientRect().top ?? 0)
	);
}

export function anchorTo(index: number): void {
	scrollToIndex(index);
}

function onscroll() {
	recordScrollTop(viewport?.scrollTop ?? 0);
	panLeft = viewport?.scrollLeft ?? 0;
	if (
		viewport?.contains(document.activeElement) &&
		document.activeElement?.closest("[data-measured-row]")
	) {
		const activeRow = document.activeElement.closest("[data-measured-row]");
		const key = activeRow && measuredRows.get(activeRow);
		const index = key ? measuredIndexes.get(key) : undefined;
		if (
			typeof index === "number" &&
			(index < shown.start || index >= shown.end)
		) {
			viewport.focus({ preventScroll: true });
		}
	}
}

async function onfocusin(event: FocusEvent) {
	const target = event.target;
	if (
		!(target instanceof HTMLElement) ||
		!target.closest("[data-measured-row]")
	)
		return;

	rememberPosition();
	await revealFocused(target);
}

async function revealFocused(target: HTMLElement) {
	await tick();
	if (
		target !== document.activeElement ||
		!dimensions.ready ||
		!rows?.contains(target)
	)
		return;

	syncMeasuredRows();
	const top = documentTop(target);
	reveal(top, top + target.getBoundingClientRect().height);
}
</script>

<div
	data-testid="diff-viewport"
	class="exact-virtual-viewport absolute inset-0 overflow-y-auto overscroll-x-none"
	class:overflow-x-auto={horizontal}
	class:overflow-x-hidden={!horizontal}
	tabindex="-1"
	bind:this={viewport}
	{onscroll}
	{onfocusin}
>
	<div
		class="exact-virtual-content relative min-w-full"
		style:height="{contentHeight}px"
		style:width={contentWidth}
	>
		<div
			class="exact-virtual-surface sticky top-0 w-full min-w-full overflow-clip"
			style:height="{Math.min(viewportHeight, contentHeight)}px"
		>
			<div
				class="exact-virtual-rows absolute left-0 w-full min-w-full"
				bind:this={rows}
				style:--pan-x="{panLeft}px"
				style:top="{(sections.length === 0 ? shown.offsetTop : 0) -
					renderedScrollTop}px"
			>
				{#if sections.length === 0}
					{#each visible as item, offset (shown.start + offset)}
						{@render renderItem(item, shown.start + offset)}
					{/each}
				{:else}
					{#each sections as section (section.key)}
						{#if section.kind === "measured"}
							<div
								class="flow-root"
								data-measured-row={section.key}
								inert={!dimensions.ready ||
									section.index < shown.start ||
									section.index >= shown.end}
								use:measureRow={section.key}
							>
								{@render renderItem(items[section.index], section.index)}
							</div>
						{:else}
							{@const first = Math.max(section.start, shown.start)}
							{@const end = Math.min(section.end, shown.end)}
							<div
								class="flow-root"
								style:height="{offsets[section.end] - offsets[section.start]}px"
							>
								{#if dimensions.ready && first < end}
									<div
										style:height="{offsets[first] - offsets[section.start]}px"
									></div>
									{#each items.slice(first, end) as item, offset (first +
										offset)}
										{@render renderItem(item, first + offset)}
									{/each}
								{/if}
							</div>
						{/if}
					{/each}
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
/* The rows are positioned by arithmetic, so the browser's own anchor adjustment
   would fight every height recompute. */
.exact-virtual-viewport {
	overflow-anchor: none;
}
</style>
