<script module lang="ts">
import type { Snippet } from "svelte";

export const MARKER_CHUNK = 512;
const FANOUT = 32;
const subscribers = new WeakMap<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
</script>

<script lang="ts">
let { text, children }: { text: string; children: Snippet<[number, number]> } =
	$props();

// Offscreen chunks stay plain text so the browser lays out the same tabs,
// bidi text and soft breaks. One observer serves every merge pane.
const visible = $state<Record<number, boolean>>({});

function watch(node: HTMLElement, key: number) {
	observer ??= new IntersectionObserver((entries) => {
		for (const entry of entries)
			subscribers.get(entry.target)?.(entry.isIntersecting);
	});
	subscribers.set(node, (show) => {
		visible[key] = show;
	});
	observer.observe(node);

	return {
		destroy() {
			observer?.unobserve(node);
			subscribers.delete(node);
			delete visible[key];
		},
	};
}

function boundaries(start: number, end: number): number[] {
	const size = Math.max(MARKER_CHUNK, Math.ceil((end - start) / FANOUT));

	const result = [start];
	for (let at = start + size; at < end; at += size) {
		const next = text.charCodeAt(at);
		// Keep supplementary characters intact across sibling text nodes.
		const boundary = next >= 0xdc00 && next <= 0xdfff ? at + 1 : at;
		if (boundary < end) result.push(boundary);
	}
	result.push(end);

	return result;
}
</script>

{#snippet chunks(from: number, to: number, parent: number)}
	{@const edges = boundaries(from, to)}
	{#each edges.slice(1) as end, i}
		{@const start = edges[i]}
		{@const key = parent * FANOUT + i + 1}
		<span use:watch={key}
			>{#if !visible[key]}
				{text.slice(start, end)}
			{:else if end - start > MARKER_CHUNK + 1}
				{@render chunks(start, end, key)}
			{:else}
				{@render children(start, end)}
			{/if}</span
		>
	{/each}
{/snippet}

{@render chunks(0, text.length, 0)}
