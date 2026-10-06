<script module lang="ts">
// The state of a thread or a review as a tinted pill: a glyph and a word in the
// state's color. A label and no control, so it sits beside a control without
// competing with it. Stale and orphaned are flags rather than states, drawn the
// same way so a card shows them beside the state they qualify. A review's state
// carries no glyph: composing is dashed and muted, since nothing is published.

import type { ReviewState, ThreadState } from "../../lib/types.js";

type PillState = ThreadState | ReviewState | "stale" | "orphaned";

export const THREAD_LABELS: Record<ThreadState | "stale", string> = {
	open: "Open",
	addressed: "Addressed",
	done: "Done",
	dismissed: "Dismissed",
	stale: "Stale",
};

const LABELS: Record<PillState, string> = {
	...THREAD_LABELS,
	orphaned: "Orphaned",
	composing: "Composing",
	ready: "Ready",
	settled: "Settled",
};

function isReviewState(state: PillState): state is ReviewState {
	return state === "composing" || state === "ready" || state === "settled";
}
</script>

<script lang="ts">
import StateGlyph from "./StateGlyph.svelte";

interface Props {
	state: PillState;
}

let { state }: Props = $props();

const PILL =
	"state-pill inline-flex items-center gap-1 shrink-0 h-control-xs pr-2 rounded-full text-caption font-medium font-sans whitespace-nowrap";
</script>

<span
	class="{PILL} pill-{state}"
	class:pl-1={!isReviewState(state)}
	class:pl-2={isReviewState(state)}
>
	{#if !isReviewState(state)}
		<StateGlyph {state} size={11} />
	{/if}
	<span>{LABELS[state]}</span>
</span>

<style>
.state-pill {
	color: var(--pill-color);
	background: color-mix(in oklch, var(--pill-color) 12%, transparent);
	box-shadow: inset 0 0 0 1px
		color-mix(in oklch, var(--pill-color) 30%, transparent);
}
.pill-open,
.pill-ready {
	--pill-color: var(--color-thread-open);
}
.pill-addressed {
	--pill-color: var(--color-thread-addressed);
}
.pill-done,
.pill-settled {
	--pill-color: var(--color-thread-done);
}
.pill-dismissed {
	--pill-color: var(--color-thread-dismissed);
}
.pill-orphaned {
	--pill-color: var(--color-danger);
}
.pill-composing {
	--pill-color: var(--color-text-muted);
}
.pill-stale {
	--pill-color: var(--color-thread-stale);
}
.pill-composing,
.pill-stale {
	background: transparent;
	box-shadow: none;
	border: 1px dashed color-mix(in oklch, var(--pill-color) 70%, transparent);
}
</style>
