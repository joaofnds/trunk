<script lang="ts">
// The code a thread was left on, one line per row, cut with an ellipsis rather
// than wrapped, under an optional note about it.

import type { Snippet } from "svelte";
import type { ExcerptLine } from "./mock.js";

interface Props {
	lines: ExcerptLine[];
	/** Drawn faded, for code that has moved or changed since. */
	dim?: boolean;
	children?: Snippet;
}

let { lines, dim = false, children }: Props = $props();

const GUTTER = { add: "+", del: "-", context: " " } as const;
</script>

<div class="proto-excerpt" class:proto-excerpt-dim={dim}>
	{#if children}
		<p class="m-0 px-3 pb-1 font-sans text-small text-text-subtle">
			{@render children()}
		</p>
	{/if}
	{#each lines as line, i (i)}
		<div class="proto-line proto-line-{line.kind}">
			<span class="proto-number select-none">{line.number ?? ""}</span>
			<span class="proto-gutter select-none">{GUTTER[line.kind]}</span>
			<span class="proto-content select-text">{line.content}</span>
		</div>
	{/each}
</div>

<style>
.proto-excerpt {
	font-family: var(--font-mono);
	font-size: var(--text-small);
	line-height: var(--leading-normal);
	background: var(--color-bg);
	box-shadow: var(--shadow-hairline);
	padding: var(--space-1) 0;
}
.proto-line {
	display: grid;
	grid-template-columns: calc(10 * var(--u)) calc(3 * var(--u)) minmax(0, 1fr);
}
.proto-line-add {
	background: var(--color-diff-add-bg);
	box-shadow: inset 2px 0 0 var(--color-diff-add);
}
.proto-line-del {
	background: var(--color-diff-delete-bg);
	box-shadow: inset 2px 0 0 var(--color-diff-delete);
}
.proto-number {
	padding-right: var(--space-2);
	text-align: right;
	color: var(--color-text-subtle);
}
.proto-gutter {
	color: var(--color-text-subtle);
}
.proto-line-add .proto-gutter {
	color: var(--color-diff-add);
}
.proto-line-del .proto-gutter {
	color: var(--color-diff-delete);
}
.proto-content {
	padding-right: var(--space-3);
	white-space: pre;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--color-diff-text);
}
.proto-excerpt-dim .proto-content {
	color: var(--color-text-subtle);
}
</style>
