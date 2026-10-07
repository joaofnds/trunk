<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	icon?: Snippet;
	title: string;
	/** The paragraphs that say why it is empty and what fills it. */
	children: Snippet;
	actions?: Snippet;
}

let { icon, title, children, actions }: Props = $props();

const headingId = $props.id();
</script>

<!-- Why the review panel has nothing to show, and the way to fill it. -->
<section
	aria-labelledby={headingId}
	class="flex flex-1 items-center justify-center p-6"
>
	<div class="review-empty flex flex-col gap-2">
		{#if icon}
			<span
				class="review-empty-icon inline-flex items-center justify-center mb-1 rounded border border-border bg-surface-raised text-text-muted"
				aria-hidden="true"
				>{@render icon()}</span
			>
		{/if}
		<h3 id={headingId} class="m-0 text-title font-semibold text-text-strong">
			{title}
		</h3>
		{@render children()}
		{#if actions}
			<div class="flex gap-2 mt-2">{@render actions()}</div>
		{/if}
	</div>
</section>

<style>
.review-empty {
	max-width: calc(96 * var(--u));
}

.review-empty-icon {
	width: calc(9 * var(--u));
	height: calc(9 * var(--u));
}

.review-empty :global(p) {
	margin: 0;
	color: var(--color-text-muted);
	font-size: var(--text-callout);
	line-height: var(--leading-normal);
	text-wrap: pretty;
}
</style>
