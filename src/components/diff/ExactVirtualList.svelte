<script lang="ts" generics="TItem">
import { onMount, type Snippet } from "svelte";
import { buildOffsets, windowFor } from "../../lib/virtual-window.js";

interface Props {
	items: TItem[];
	/** Exact height per item, same length and order as `items`. */
	heights: number[];
	/** CSS width of the scrollable content, computed rather than measured. */
	contentWidth: string;
	horizontal?: boolean;
	/** Runway either side, in pixels. Defaults to one viewport height. */
	overscanPx?: number;
	renderItem: Snippet<[TItem, number]>;
}

let {
	items,
	heights,
	contentWidth,
	horizontal = true,
	overscanPx,
	renderItem,
}: Props = $props();

let viewport = $state<HTMLDivElement | null>(null);
let scrollTop = $state(0);
// Published once, on the rows container, as the `--pan-x` every row's own
// transform reads, so a horizontal scroll re-renders no row.
let panLeft = $state(0);
let viewportHeight = $state(0);

const offsets = $derived(buildOffsets(heights));
const runway = $derived(overscanPx ?? viewportHeight);
const shown = $derived(windowFor(offsets, scrollTop, viewportHeight, runway));
const visible = $derived(items.slice(shown.start, shown.end));

onMount(() => {
	const el = viewport;
	if (!el) return;

	const measure = () => {
		viewportHeight = el.clientHeight;
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

export function scrollToIndex(index: number): void {
	if (!viewport) return;

	const clamped = Math.max(0, Math.min(index, items.length - 1));
	viewport.scrollTop = offsets[clamped];
	scrollTop = viewport.scrollTop;
}

/** Scrolls the least distance that shows the whole row, and not at all when it
 *  already shows. */
export function revealIndex(index: number): void {
	if (!viewport) return;

	const top = offsets[index];
	const bottom = offsets[index + 1];
	if (top < scrollTop) {
		viewport.scrollTop = top;
	} else if (bottom > scrollTop + viewportHeight) {
		viewport.scrollTop = bottom - viewportHeight;
	}

	scrollTop = viewport.scrollTop;
}

export function anchorTo(index: number): void {
	scrollToIndex(index);
}

function onscroll() {
	scrollTop = viewport?.scrollTop ?? 0;
	panLeft = viewport?.scrollLeft ?? 0;
}
</script>

<div
	class="exact-virtual-viewport absolute inset-0 overflow-y-auto overscroll-x-none"
	class:overflow-x-auto={horizontal}
	class:overflow-x-hidden={!horizontal}
	bind:this={viewport}
	{onscroll}
>
	<div
		class="exact-virtual-content relative min-w-full"
		style:height="{shown.totalHeight}px"
		style:width={contentWidth}
	>
		<div
			class="exact-virtual-rows absolute top-0 left-0 w-full min-w-full"
			style:--pan-x="{panLeft}px"
			style:transform="translateY({shown.offsetTop}px)"
		>
			{#each visible as item, offset (shown.start + offset)}
				{@render renderItem(item, shown.start + offset)}
			{/each}
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
