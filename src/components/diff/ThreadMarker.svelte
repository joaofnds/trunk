<script lang="ts">
// The threads starting on a diff line, counted in the state of the most urgent,
// in the column the row model reserves while any thread is in view. A line with
// none draws the empty column, so every row's code starts at the same place.
// The thread cards under the thread's last line say the same thing to
// assistive tech, so the pill is hidden from it.
import type { LineMarker } from "../../lib/diff-rows.js";
import { threadToneColor } from "../../lib/review-filter.js";

interface Props {
	marker: LineMarker | null;
	width: string;
}

let { marker, width }: Props = $props();
</script>

<span class="thread-marker-cell" style:min-width={width}
	>{#if marker}
		<span
			class="thread-marker"
			aria-hidden="true"
			style:--thread-tone={threadToneColor(marker.tone)}
			>{marker.count}</span
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
