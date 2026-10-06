<script lang="ts">
// Who wrote a comment or a reply, and how long ago. The person at the keyboard
// is "You" and the agent is "Agent", in its own color and named with the route
// it wrote through.

import { currentMinute } from "../../lib/now.svelte.js";
import { exactLabel, relativeLabel } from "../../lib/relative-time.js";
import type { Channel } from "../../lib/types.js";

interface Props {
	channel: Channel;
	createdAt: number;
}

let { channel, createdAt }: Props = $props();
</script>

<span class="flex min-w-0 items-baseline gap-2">
	{#if channel === "agent"}
		<span class="text-callout font-semibold text-accent-alt">Agent</span>
		<span class="font-mono text-caption text-text-subtle">via trunk CLI</span>
	{:else}
		<span class="text-callout font-semibold text-text-strong">You</span>
	{/if}
	<time
		class="font-mono text-caption text-text-subtle"
		title={exactLabel(createdAt)}
		>{relativeLabel(createdAt, currentMinute())}</time
	>
</span>
