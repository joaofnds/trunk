<script lang="ts">
// The code a thread was left on, one line per row, cut with an ellipsis rather
// than wrapped.

import type { ExcerptLine } from "./mock.js";

interface Props {
	lines: ExcerptLine[];
	/** Saved code that has moved or changed since, drawn faded under a note
	 *  that says so. */
	stale?: boolean;
}

let { lines, stale = false }: Props = $props();

const GUTTER = { add: "+", del: "-", context: " " } as const;
</script>

<div class="proto-excerpt" class:proto-excerpt-stale={stale}>
	{#if stale}
		<p
			class="m-0 flex h-control items-center px-3 font-sans text-small text-text-subtle shadow-hairline"
		>
			Saved excerpt. These lines have moved or changed since.
		</p>
	{/if}
	<div class="py-1">
		{#each lines as line, i (i)}
			<div class="proto-line proto-line-{line.kind}">
				<span class="proto-number select-none">{line.number ?? ""}</span>
				<span class="proto-gutter select-none">{GUTTER[line.kind]}</span>
				<span class="proto-content select-text">{line.content}</span>
			</div>
		{/each}
	</div>
</div>

<style>
.proto-excerpt {
	font-family: var(--font-mono);
	font-size: var(--text-small);
	line-height: var(--leading-code);
	background: var(--color-bg);
	box-shadow: var(--shadow-hairline);
}
.proto-line {
	display: grid;
	grid-template-columns: calc(10 * var(--u)) calc(3 * var(--u)) minmax(0, 1fr);
}
.proto-line-add {
	background: var(--color-diff-add-bg);
}
.proto-line-del {
	background: var(--color-diff-delete-bg);
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
.proto-excerpt-stale .proto-content {
	color: var(--color-text-subtle);
}
</style>
