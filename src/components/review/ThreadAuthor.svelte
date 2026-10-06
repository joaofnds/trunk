<script lang="ts">
// Who wrote a comment or a reply, and how long ago. The person at the keyboard
// is "You" and the agent is "Agent", each with its own glyph and the agent in its
// own color, so a thread reads as a conversation between the two at a glance.

import CircleUser from "@lucide/svelte/icons/circle-user";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import { currentMinute } from "../../lib/now.svelte.js";
import { exactLabel, relativeLabel } from "../../lib/relative-time.js";
import type { Channel } from "../../lib/types.js";

interface Props {
	channel: Channel;
	createdAt: number;
}

let { channel, createdAt }: Props = $props();
</script>

<span class="flex items-center gap-2 min-w-0 text-small leading-normal">
	{#if channel === "agent"}
		<SquareTerminal
			size={14}
			class="shrink-0 text-accent-alt"
			aria-hidden="true"
		/>
		<span class="font-medium text-accent-alt">Agent</span>
		<span class="font-mono text-caption text-text-subtle">via trunk CLI</span>
	{:else}
		<CircleUser size={14} class="shrink-0 text-text-muted" aria-hidden="true" />
		<span class="font-medium text-text-strong">You</span>
	{/if}
	<time class="text-text-subtle" title={exactLabel(createdAt)}
		>{relativeLabel(createdAt, currentMinute())}</time
	>
</span>
