<script lang="ts">
// A thread's state as a shape that survives without its color: a ring while it
// is open, half filled once the agent addressed it, filled with a check once
// done, struck through once dismissed. The stale, orphaned and pending flags
// take their icons, since they qualify a state rather than being one.

import Clock from "@lucide/svelte/icons/clock";
import History from "@lucide/svelte/icons/history";
import Unlink from "@lucide/svelte/icons/unlink";
import type { ThreadState } from "../../lib/types.js";

interface Props {
	state: ThreadState | "stale" | "orphaned" | "pending";
	size?: number;
}

let { state, size = 12 }: Props = $props();
</script>

{#if state === "stale"}
	<History {size} aria-hidden="true" class="shrink-0" />
{:else if state === "orphaned"}
	<Unlink {size} aria-hidden="true" class="shrink-0" />
{:else if state === "pending"}
	<Clock {size} aria-hidden="true" class="shrink-0" />
{:else}
	<svg
		class="shrink-0"
		width={size}
		height={size}
		viewBox="0 0 12 12"
		aria-hidden="true"
		data-state={state}
	>
		{#if state === "done"}
			<circle cx="6" cy="6" r="5.2" fill="currentColor" />
			<path class="state-glyph-check" d="M3.6 6.1l1.7 1.7 3.2-3.5" />
		{:else}
			<circle class="state-glyph-ring" cx="6" cy="6" r="4.4" />
			{#if state === "addressed"}
				<path d="M6 1.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" />
			{:else if state === "dismissed"}
				<path class="state-glyph-ring" d="M3 9l6-6" />
			{/if}
		{/if}
	</svg>
{/if}

<style>
.state-glyph-ring {
	fill: none;
	stroke: currentColor;
	stroke-width: 1.5;
}
.state-glyph-check {
	fill: none;
	stroke: var(--color-surface);
	stroke-width: 1.5;
	stroke-linecap: round;
	stroke-linejoin: round;
}
</style>
