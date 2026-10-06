<script lang="ts">
// A review-comment count at the trailing edge of a row: a message glyph and the
// number, in the tone of the threads it counts. Outlined rather than filled, so
// it clears AAA on a selected row as well as a resting one. Self-hides at 0 so
// a parent can enforce the filter gate simply by zeroing the count, which keeps
// children dumb.
import MessageSquare from "@lucide/svelte/icons/message-square";
import type { ReviewTone } from "../lib/types.js";

interface Props {
	count: number;
	tone?: ReviewTone | null;
}

let { count, tone = "open" }: Props = $props();
</script>

{#if count > 0}
	{@const effectiveTone = tone ?? "open"}
	<span
		class="comment-badge tone-{effectiveTone}"
		role="img"
		aria-label="{count} review {count === 1 ? 'comment' : 'comments'}"
		><MessageSquare size={10} strokeWidth={2.5} aria-hidden="true" />
		{count}</span
	>
{/if}

<style>
.comment-badge {
	flex-shrink: 0;
	height: calc(4 * var(--u));
	padding: 0 var(--space-1);
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-pill);
	font-size: var(--text-caption);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-none);
}
.tone-open {
	color: var(--color-thread-open);
	border-color: color-mix(in oklch, var(--color-thread-open) 35%, transparent);
}
.tone-addressed {
	color: var(--color-thread-addressed);
	border-color: color-mix(
		in oklch,
		var(--color-thread-addressed) 35%,
		transparent
	);
}
.tone-done {
	color: var(--color-thread-done);
	border-color: color-mix(in oklch, var(--color-thread-done) 35%, transparent);
}
.tone-dismissed {
	color: var(--color-thread-dismissed);
	border-color: color-mix(
		in oklch,
		var(--color-thread-dismissed) 35%,
		transparent
	);
}
.tone-stale {
	color: var(--color-thread-stale);
	border-color: color-mix(in oklch, var(--color-thread-stale) 35%, transparent);
}
</style>
