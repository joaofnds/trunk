<script lang="ts">
// The count of threads hanging on a diff line, in the column the row model
// reserves while any thread hangs in view. A line with none draws the empty
// column, so every row's code starts at the same place. The thread cards right
// under the line say the same thing to assistive tech, so the pill is hidden
// from it.

interface Props {
	count: number;
	width: string;
}

let { count, width }: Props = $props();
</script>

<span class="thread-marker-cell" style:min-width={width}
	>{#if count > 0}
		<span class="thread-marker" aria-hidden="true">{count}</span>
	{/if}</span
>

<style>
/* A caption pill inside the row's own line box, so the row keeps the height
     the model computed for it. */
.thread-marker-cell {
	display: inline-flex;
	flex-shrink: 0;
	align-self: stretch;
	align-items: center;
	user-select: none;
}
.thread-marker {
	min-width: calc(4 * var(--u));
	padding: 0 var(--space-1);
	border-radius: var(--radius);
	background: var(--color-accent);
	color: var(--color-on-accent);
	font-family: var(--font-sans);
	font-size: var(--text-caption);
	line-height: var(--text-caption--line-height);
	font-weight: var(--weight-semibold);
	text-align: center;
}
</style>
