<script lang="ts">
// One turn of a thread: the author's face, who they are and how long ago they
// wrote, then what they wrote. The agent's turns sit on a faint wash of its
// color, so a long thread still reads as who said what without the names.

import type { Snippet } from "svelte";
import type { Channel } from "../../lib/types.js";
import MessageAvatar from "./MessageAvatar.svelte";
import StatePill from "./StatePill.svelte";
import ThreadAuthor from "./ThreadAuthor.svelte";

interface Props {
	channel: Channel;
	createdAt: number;
	/** Held in the review's batch, which the agent cannot read until it is sent. */
	pending?: boolean;
	/** Controls drawn at the end of the author line, such as edit and delete. */
	actions?: Snippet;
	children: Snippet;
}

let {
	channel,
	createdAt,
	pending = false,
	actions,
	children,
}: Props = $props();
</script>

<div
	class="thread-message grid gap-2 py-2 pr-3 pl-2"
	class:thread-message-agent={channel === "agent"}
>
	<MessageAvatar {channel} />
	<div class="flex min-w-0 flex-col gap-1">
		<div class="flex min-w-0 items-center gap-2">
			<ThreadAuthor {channel} {createdAt} />
			{#if pending}
				<StatePill state="pending" />
			{/if}
			<span class="flex-1"></span>
			{#if actions}
				<span class="thread-message-actions flex items-center gap-2">
					{@render actions()}
				</span>
			{/if}
		</div>
		{@render children()}
	</div>
</div>

<style>
.thread-message {
	grid-template-columns: calc(5 * var(--u)) minmax(0, 1fr);
}
/* The card header holds its actions a step from the edge, where the message
   holds its text three; the actions take the header's column. */
.thread-message-actions {
	margin-right: calc(-1 * var(--space-2));
}
.thread-message-agent {
	background: color-mix(in oklch, var(--color-accent-alt) 6%, transparent);
}
</style>
