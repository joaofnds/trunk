<script module lang="ts">
// The state of a thread or a review as a tinted pill: a glyph and a word in the
// state's color. A label and no control, so it sits beside a control without
// competing with it. Stale and orphaned are flags rather than states, drawn the
// same way so a card shows them beside the state they qualify, as is pending,
// which marks a comment held in its review's batch. A review's state carries no
// glyph, and shares its color with the thread state of the same name.

import type { ReviewState, ThreadState } from "../../lib/types.js";

type ThreadPill = ThreadState | "stale" | "orphaned" | "pending";

export const THREAD_LABELS: Record<ThreadState | "stale", string> = {
	open: "Open",
	addressed: "Addressed",
	done: "Done",
	dismissed: "Dismissed",
	stale: "Stale",
};

const LABELS: Record<ThreadPill | ReviewState, string> = {
	...THREAD_LABELS,
	orphaned: "Orphaned",
	pending: "Pending",
	settled: "Settled",
};
</script>

<script lang="ts">
import StateGlyph from "./StateGlyph.svelte";

type Props = { state: ThreadPill } | { review: ReviewState };

let props: Props = $props();

const glyph = $derived("state" in props ? props.state : null);
const shown = $derived("state" in props ? props.state : props.review);

const PILL =
	"state-pill inline-flex items-center gap-1 shrink-0 h-control-xs pr-2 rounded-full text-caption font-medium font-sans whitespace-nowrap";
</script>

<span
	class="{PILL} pill-{shown}"
	class:pl-1={glyph !== null}
	class:pl-2={glyph === null}
>
	{#if glyph !== null}
		<StateGlyph state={glyph} size={11} />
	{/if}
	<span>{LABELS[shown]}</span>
</span>

<style>
.state-pill {
	color: var(--pill-color);
	background: color-mix(in oklch, var(--pill-color) 12%, transparent);
	box-shadow: inset 0 0 0 1px
		color-mix(in oklch, var(--pill-color) 30%, transparent);
}
.pill-open {
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
.pill-pending {
	--pill-color: var(--color-text-muted);
}
.pill-stale {
	--pill-color: var(--color-thread-stale);
}
.pill-pending,
.pill-stale {
	background: transparent;
	box-shadow: none;
	border: 1px dashed color-mix(in oklch, var(--pill-color) 70%, transparent);
}
</style>
