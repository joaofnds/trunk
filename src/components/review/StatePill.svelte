<script module lang="ts">
// The state of a thread or a review as a tinted pill: a glyph and a word in the
// state's color. A label and no control, so it sits beside a control without
// competing with it. The stale marker is a flag rather than a state, but it is
// drawn the same way so a card can show it beside the state it qualifies.

import Check from "@lucide/svelte/icons/check";
import Circle from "@lucide/svelte/icons/circle";
import CircleDashed from "@lucide/svelte/icons/circle-dashed";
import CircleSlash from "@lucide/svelte/icons/circle-slash";
import Clock from "@lucide/svelte/icons/clock";
import Contrast from "@lucide/svelte/icons/contrast";
import type { Component } from "svelte";
import type { ReviewState, ThreadState } from "../../lib/types.js";

type PillState = ThreadState | ReviewState | "stale";

export const THREAD_LOOKS: Record<
	ThreadState | "stale",
	{ label: string; icon: Component }
> = {
	open: { label: "Open", icon: Circle },
	addressed: { label: "Addressed", icon: Contrast },
	done: { label: "Done", icon: Check },
	dismissed: { label: "Dismissed", icon: CircleSlash },
	stale: { label: "Stale", icon: Clock },
};

const STATE_LOOKS: Record<
	PillState,
	{ label: string; icon: Component | null }
> = {
	...THREAD_LOOKS,
	composing: { label: "Composing", icon: CircleDashed },
	ready: { label: "Ready", icon: null },
	settled: { label: "Settled", icon: null },
};
</script>

<script lang="ts">
interface Props {
	state: PillState;
}

let { state }: Props = $props();

const look = $derived(STATE_LOOKS[state]);

const PILL =
	"state-pill inline-flex items-center gap-1 shrink-0 px-1 rounded-full text-caption leading-none font-medium whitespace-nowrap";
</script>

<span class="{PILL} pill-{state}">
	{#if look.icon}
		<look.icon size={10} strokeWidth={2.5} aria-hidden="true" />
	{/if}
	<span>{look.label}</span>
</span>

<style>
.state-pill {
	height: calc(4 * var(--u));
	border: 1px solid var(--color-border);
}
.pill-open,
.pill-ready {
	color: var(--color-thread-open);
	background: color-mix(in oklch, var(--color-thread-open) 12%, transparent);
	border-color: color-mix(in oklch, var(--color-thread-open) 35%, transparent);
}
.pill-addressed {
	color: var(--color-thread-addressed);
	background: color-mix(
		in oklch,
		var(--color-thread-addressed) 12%,
		transparent
	);
	border-color: color-mix(
		in oklch,
		var(--color-thread-addressed) 35%,
		transparent
	);
}
.pill-composing {
	color: var(--color-thread-addressed);
	border: 1px dashed var(--color-thread-addressed);
}
.pill-done,
.pill-settled {
	color: var(--color-thread-done);
	background: color-mix(in oklch, var(--color-thread-done) 12%, transparent);
	border-color: color-mix(in oklch, var(--color-thread-done) 35%, transparent);
}
.pill-dismissed {
	color: var(--color-thread-dismissed);
	background: var(--color-hover);
}
.pill-stale {
	color: var(--color-thread-stale);
	background: color-mix(in oklch, var(--color-thread-stale) 12%, transparent);
	border-color: color-mix(in oklch, var(--color-thread-stale) 35%, transparent);
}
</style>
