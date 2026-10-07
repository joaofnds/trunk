<script lang="ts">
// One move of a thread's state, set between the replies it came between: who
// moved it, to what, the commit the agent named as its fix, and how long ago.

import { currentMinute } from "../../lib/now.svelte.js";
import { compactLabel, exactLabel } from "../../lib/relative-time.js";
import { CHANGE_TEXT } from "../../lib/thread-timeline.js";
import type { StateChange } from "../../lib/types.js";
import StateGlyph from "./StateGlyph.svelte";

interface Props {
	change: StateChange;
}

let { change }: Props = $props();
</script>

<div
	class="flex h-control items-center gap-2 overflow-hidden whitespace-nowrap px-3 text-small text-text-muted"
>
	<StateGlyph state={change.state} size={12} />
	{#if change.channel === "agent"}
		<span class="font-semibold text-accent-alt">Agent</span>
	{:else}
		<span class="font-semibold text-text">You</span>
	{/if}
	<span>{CHANGE_TEXT[change.state]}</span>
	{#if change.commit}
		<span>in</span>
		<code
			class="inline-flex h-control-xs items-center rounded bg-surface-chip px-1 font-mono text-caption font-medium text-text-strong"
			title={change.commit}
			>{change.commit.slice(0, 7)}</code
		>
	{/if}
	<time
		class="shrink-0 font-mono text-caption text-text-subtle"
		title={exactLabel(change.created_at)}
		>· {compactLabel(change.created_at, currentMinute())}</time
	>
</div>
