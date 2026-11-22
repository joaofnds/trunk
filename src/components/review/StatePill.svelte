<script module lang="ts">
// Thread headers show ordinary states as a glyph and label. The frame is
// reserved for flags, held messages and review summaries.

import type { ReviewState, ThreadState } from "../../lib/types.js";

type ThreadPill = ThreadState | "stale" | "orphaned" | "pending";

export const THREAD_LABELS: Record<ThreadState | "stale", string> = {
	open: "Open",
	addressed: "Addressed",
	done: "Done",
	dismissed: "Dismissed",
	stale: "Stale",
};

const LABELS: Record<Exclude<ThreadPill, "orphaned"> | ReviewState, string> = {
	...THREAD_LABELS,
	pending: "Pending",
	settled: "Settled",
};
</script>

<script lang="ts">
import StateGlyph from "./StateGlyph.svelte";

type Props =
	| { state: Exclude<ThreadPill, "orphaned"> }
	| { state: "orphaned"; reason: string }
	| { review: ReviewState };

let props: Props = $props();

const glyph = $derived("state" in props ? props.state : null);
const shown = $derived("state" in props ? props.state : props.review);

const label = $derived(
	"reason" in props
		? props.reason
		: LABELS["state" in props ? props.state : props.review],
);
const framed = $derived(
	glyph === null ||
		glyph === "orphaned" ||
		glyph === "pending" ||
		glyph === "stale",
);

const PILL =
	"state-pill inline-flex items-center gap-1 shrink-0 h-control-xs text-caption font-medium font-sans whitespace-nowrap";
</script>

<span
	class="{PILL} pill-{shown}"
	class:pill-frame={framed}
	class:rounded-full={framed}
	class:pr-2={framed}
	class:pl-1={framed && glyph !== null}
	class:pl-2={glyph === null}
>
	{#if glyph !== null}
		<StateGlyph state={glyph} size={11} />
	{/if}
	<span>{label}</span>
</span>

<style>
.state-pill {
	color: var(--pill-color);
}
.pill-frame {
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
.pill-frame.pill-pending,
.pill-frame.pill-stale {
	background: transparent;
	box-shadow: none;
	border: 1px dashed color-mix(in oklch, var(--pill-color) 70%, transparent);
}
</style>
