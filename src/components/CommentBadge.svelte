<script lang="ts">
// Filled accent pill showing a review-comment count. Shares the look of the
// toolbar badge (.toolbar-badge) but is statically positioned so it flows
// inline at the trailing edge of a row. Self-hides at 0 so a parent can enforce
// the toggle/active gate simply by zeroing the count — children stay dumb.
interface Props {
	count: number;
}

let { count }: Props = $props();
</script>

{#if count > 0}
  <span class="comment-badge" aria-label="{count} {count === 1 ? 'comment' : 'comments'}">{count}</span>
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
</style>
