<script lang="ts">
// A review-comment count at the trailing edge of a row: a message glyph and the
// number, in the tone of the threads it counts. A count that holds threads in
// more than one state splits into a pill per state, most urgent first, so open
// work and work waiting on the reader read apart. Outlined rather than filled,
// so it clears AAA on a selected row as well as a resting one. Self-hides at 0
// so a parent can enforce the filter gate simply by zeroing the count, which
// keeps children dumb.
import MessageSquare from "@lucide/svelte/icons/message-square";
import { tallyEntries } from "../lib/review-filter.js";
import type { ReviewTally, ReviewTone } from "../lib/types.js";

interface Props {
	count: number;
	tone?: ReviewTone | null;
	/** The count by state. Without one the badge is a single pill in `tone`. */
	tally?: ReviewTally | null;
}

let { count, tone = "open", tally = null }: Props = $props();

const pills = $derived.by(() => {
	const entries = tallyEntries(tally);
	return entries.length > 0 ? entries : [{ tone: tone ?? "open", count }];
});

const label = $derived.by(() => {
	const total = `${count} review ${count === 1 ? "comment" : "comments"}`;
	if (pills.length < 2) return total;
	const shares = pills.map((pill) => `${pill.count} ${pill.tone}`);
	return `${total}, ${shares.slice(0, -1).join(", ")} and ${shares.at(-1)}`;
});
</script>

{#if count > 0}
	<span class="comment-badge" role="img" aria-label={label}>
		{#each pills as pill, index (pill.tone)}
			<span class="comment-badge-pill tone-{pill.tone}"
				>{#if index === 0}
					<MessageSquare size={10} strokeWidth={2.5} aria-hidden="true" />
				{/if}
				{pill.count}</span
			>
		{/each}
	</span>
{/if}

<style>
.comment-badge {
	flex-shrink: 0;
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}
.comment-badge-pill {
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
