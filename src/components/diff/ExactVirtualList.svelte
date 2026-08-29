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
// Published to the rows below in the same reactive style string that carries
// translateY: Svelte's set_style assigns cssText wholesale, so a custom property
// set imperatively on this element would be wiped on the next vertical scroll.
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

export function anchorTo(index: number): void {
	scrollToIndex(index);
}

function onscroll() {
	scrollTop = viewport?.scrollTop ?? 0;
	panLeft = viewport?.scrollLeft ?? 0;
}
</script>

<div
  class="exact-virtual-viewport"
  bind:this={viewport}
  {onscroll}
  style="position: absolute; inset: 0; overflow-y: auto; overflow-x: {horizontal ? 'auto' : 'hidden'}; overscroll-behavior-x: none; overflow-anchor: none;"
>
  <div
    class="exact-virtual-content"
    style="position: relative; height: {shown.totalHeight}px; width: {contentWidth}; min-width: 100%;"
  >
    <div
      class="exact-virtual-rows"
      style="position: absolute; top: 0; left: 0; width: 100%; min-width: 100%; --pan-x: {panLeft}px; transform: translateY({shown.offsetTop}px);"
    >
      {#each visible as item, offset (shown.start + offset)}
        {@render renderItem(item, shown.start + offset)}
      {/each}
    </div>
  </div>
</div>
