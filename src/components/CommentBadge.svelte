<script lang="ts">
// Filled accent pill showing a review-comment count. Shares the look of the
// toolbar badge (.toolbar-badge) but is statically positioned so it flows
// inline at the trailing edge of a row. Self-hides at 0 so a parent can enforce
// the filter gate simply by zeroing the count — children stay dumb.
import type { ReviewTone } from "../lib/types.js";

interface Props {
	count: number;
	tone?: ReviewTone | null;
}

let { count, tone = "open" }: Props = $props();

const toneLabel: Record<ReviewTone, string> = {
	open: "open",
	addressed: "addressed",
	done: "done",
	dismissed: "dismissed",
	stale: "stale",
};
</script>

{#if count > 0}
  {@const effectiveTone = tone ?? "open"}
  <span
    class="comment-badge tone-{effectiveTone}"
    aria-label="{count} {toneLabel[effectiveTone]} {count === 1 ? 'comment' : 'comments'}"
  >{count}</span>
{/if}

<style>
  .comment-badge {
    flex-shrink: 0;
    min-width: 16px;
    height: 16px;
    padding: 0 var(--space-1);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }
  .tone-open { background: var(--color-thread-open); }
  .tone-addressed { background: var(--color-thread-addressed); }
  .tone-done { background: var(--color-thread-done); }
  .tone-dismissed { background: var(--color-thread-dismissed); }
  .tone-stale { background: var(--color-thread-stale); }
</style>
