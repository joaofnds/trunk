<script lang="ts">
// The threads starting on a diff line, counted in the state of the most urgent,
// in the column the row model reserves while any thread is in view. A line with
// none draws the empty column, so every row's code starts at the same place.
// The thread cards under the thread's last line say the same thing to
// assistive tech, so the pill is hidden from it.
import Plus from "@lucide/svelte/icons/plus";
import type { LineMarker } from "../../lib/diff-rows.js";
import { threadToneColor } from "../../lib/review-filter.js";
import Button from "../../lib/ui/Button.svelte";

interface Props {
	marker: LineMarker | null;
	width: string;
	/** Opens a comment on this one line; the control shows under the pointer. */
	oncomment?: () => void;
	commentLabel?: string;
}

let { marker, width, oncomment, commentLabel }: Props = $props();
</script>

<span class="thread-marker-cell" style:min-width={width}
	>{#if marker}
		<span
			class="thread-marker"
			aria-hidden="true"
			style:--thread-tone={threadToneColor(marker.tone)}
			>{marker.count}</span
		>
	{/if}{#if oncomment}
		<span class="thread-marker-add"
			><Button
				icon
				size="xs"
				variant="primary"
				aria-label={commentLabel}
				title={commentLabel}
				tabindex={-1}
				onclick={oncomment}
				><Plus size={10} aria-hidden="true" /></Button
			></span
		>
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
/* The add control takes the pill's place while the pointer is on the line. It
   is a pointer shortcut, out of the Tab order: the keyboard selects lines with
   the grip and comments from the hunk's Comment action. */
.thread-marker-add {
	display: none;
}
:global(.diff-line:hover) .thread-marker-add {
	display: inline-flex;
}
:global(.diff-line:hover) .thread-marker:has(~ .thread-marker-add) {
	display: none;
}
.thread-marker {
	min-width: calc(4 * var(--u));
	padding: 0 var(--space-1);
	border-radius: var(--radius);
	background: var(--thread-tone);
	color: var(--color-on-accent);
	font-family: var(--font-sans);
	font-size: var(--text-caption);
	line-height: var(--text-caption--line-height);
	font-weight: var(--weight-semibold);
	text-align: center;
}
</style>
