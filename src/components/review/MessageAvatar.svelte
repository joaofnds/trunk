<script lang="ts">
// Who wrote a message, as a face beside it: the reviewer in a round avatar,
// the agent as a terminal prompt in a square one in its own color, so a long
// thread reads as a conversation between the two at a glance. The reviewer's
// face is their initials once the repo names them, and a person glyph before.

import User from "@lucide/svelte/icons/user";
import { reviewer } from "../../lib/reviewer.svelte.js";
import type { Channel } from "../../lib/types.js";

interface Props {
	channel: Channel;
	size?: "md" | "sm";
}

let { channel, size = "md" }: Props = $props();

const me = reviewer();
</script>

{#if channel === "agent"}
	<span
		class="message-avatar message-avatar-agent message-avatar-{size} inline-flex shrink-0 items-center justify-center rounded font-mono text-caption leading-none font-semibold select-none"
		title="Agent (via trunk CLI)"
		>&gt;_</span
	>
{:else}
	<span
		class="message-avatar message-avatar-{size} inline-flex shrink-0 items-center justify-center rounded-full bg-surface-chip text-text select-none"
		title="You"
		>{#if me?.initials}
			<span class="font-sans text-caption leading-none font-semibold"
				>{me.initials}</span
			>
		{:else}
			<User size={size === "md" ? 12 : 10} aria-hidden="true" />
		{/if}</span
	>
{/if}

<style>
.message-avatar {
	box-shadow: inset 0 0 0 1px var(--color-border-strong);
}
.message-avatar-md {
	width: calc(5 * var(--u));
	height: calc(5 * var(--u));
}
.message-avatar-sm {
	width: var(--control-xs-h);
	height: var(--control-xs-h);
}
.message-avatar-agent {
	color: var(--color-accent-alt);
	background: color-mix(
		in oklch,
		var(--color-accent-alt) 20%,
		var(--color-surface-raised)
	);
	box-shadow: inset 0 0 0 1px
		color-mix(in oklch, var(--color-accent-alt) 45%, transparent);
}
</style>
