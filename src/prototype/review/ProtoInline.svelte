<script lang="ts">
// A file's diff with a thread opened under the line it was left on, as the
// diff panel draws it.

import File from "@lucide/svelte/icons/file";
import Excerpt from "./Excerpt.svelte";
import type { ExcerptLine, Thread } from "./mock.js";
import ProtoThread from "./ProtoThread.svelte";

interface Props {
	path: string;
	lines: ExcerptLine[];
	threadAfterLine: number;
	thread: Thread | null;
}

let { path, lines, threadAfterLine, thread = $bindable() }: Props = $props();

const at = $derived(lines.findIndex((l) => l.number === threadAfterLine) + 1);
</script>

<section
	aria-label="Diff of {path}"
	class="flex min-h-0 flex-1 flex-col overflow-auto bg-bg"
>
	<header
		class="flex h-bar shrink-0 items-center gap-2 bg-surface px-3 font-mono text-small text-text-strong shadow-hairline"
	>
		<File size={12} aria-hidden="true" />
		{path}
	</header>
	<Excerpt lines={lines.slice(0, at)} />
	{#if thread}
		<div class="proto-inline-thread">
			<ProtoThread
				bind:thread
				variant="inline"
				ondelete={() => {
					thread = null;
				}}
			/>
		</div>
	{/if}
	<Excerpt lines={lines.slice(at)} />
</section>

<style>
.proto-inline-thread {
	padding: var(--space-2) var(--space-3) var(--space-2) calc(13 * var(--u));
	background: var(--color-bg);
}
</style>
