<script lang="ts">
// An agent answer the user has not been shown: a dot to find it by while
// scanning, and words that say what it means without the color.

import type { Snippet } from "svelte";

interface Props {
	children: Snippet;
}

let { children }: Props = $props();
</script>

<span
	class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-small font-medium text-accent-strong"
	><span class="unread-dot" aria-hidden="true"></span>{@render children()}</span
>

<style>
.unread-dot {
	width: calc(3 * var(--u) / 2);
	height: calc(3 * var(--u) / 2);
	border-radius: 50%;
	background: var(--color-accent);
}
</style>
