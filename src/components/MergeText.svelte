<script lang="ts">
import { splitInvisibles, trailingWhitespaceStart } from "../lib/diff-utils.js";

import MergeWhitespaceWindow, {
	MARKER_CHUNK,
} from "./MergeWhitespaceWindow.svelte";

let {
	text,
	showInvisibles,
	trailingStart,
}: {
	text: string;
	showInvisibles: boolean;
	trailingStart?: number;
} = $props();

function endsLine(end: number): boolean {
	const rest = /[ \t]*(?:\n|$)/y;
	rest.lastIndex = end;
	return rest.test(text);
}

function markedSegments(fragment: string, trailing: number) {
	const start = Math.max(0, trailing);
	return [
		...splitInvisibles(fragment.slice(0, start), false),
		...splitInvisibles(fragment.slice(start), true),
	];
}
</script>

{#snippet fragment(content: string, trailing: number)}
	{#each markedSegments(content, trailing) as segment}
		{#if segment.isInvisible}
			{#each segment.text as whitespace, i}
				<span
					class="invisible-char"
					class:trailing-ws={segment.isTrailing}
					data-glyph={segment.glyph[i]}
					>{whitespace}</span
				>
			{/each}
		{:else}
			{segment.text}
		{/if}
	{/each}
{/snippet}

{#snippet paint(start: number, end: number)}
	{@const piece = text.slice(start, end)}
	{#if trailingStart !== undefined}
		{@render fragment(piece, trailingStart - start)}
	{:else}
		{@const lines = piece.split("\n")}
		{#each lines as line, index}
			{#if index > 0}
				{"\n"}
			{/if}{@render fragment(
				line,
				index < lines.length - 1 || endsLine(end)
					? trailingWhitespaceStart(line)
					: line.length,
			)}
		{/each}
	{/if}
{/snippet}

{#if !showInvisibles}
	{text}
{:else if text.length > MARKER_CHUNK + 1}
	<MergeWhitespaceWindow {text} children={paint} />
{:else}
	{@render paint(0, text.length)}
{/if}

<style>
.invisible-char {
	position: relative;
}
/* The glyph floats over a real space or tab so both layers of the native
   editor advance and wrap at the same position. */
.invisible-char::before {
	position: absolute;
	content: attr(data-glyph);
	color: var(--color-invisible);
}
.trailing-ws {
	background-color: var(--color-trailing-ws-bg);
}
.trailing-ws::before {
	color: var(--color-trailing-ws-fg);
}
</style>
