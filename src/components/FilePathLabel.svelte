<script lang="ts">
import { splitFilePath } from "../lib/file-path.js";

interface Props {
	path: string;
	oldPath?: string | null;
	tree?: boolean;
}

let { path, oldPath = null, tree = false }: Props = $props();

let current = $derived(splitFilePath(path));
let previous = $derived(oldPath === null ? null : splitFilePath(oldPath));
let renamed = $derived(previous !== null && previous.name !== current.name);
let moved = $derived(
	previous !== null && previous.directory !== current.directory,
);
let title = $derived(oldPath === null ? path : `${oldPath} → ${path}`);
</script>

{#snippet directory(value: string)}
	<span class="directory"><bdi>{value}</bdi></span>
{/snippet}

<span class="file-label" {title}>
	<span class="names">
		{#if previous && renamed}
			<span class="leaf former"><bdi>{previous.name}</bdi></span>
			<span class="arrow">→</span>
		{/if}
		<span class="leaf"><bdi>{current.name}</bdi></span>
	</span>
	{#if previous && moved}
		<span class="context">
			{#if tree}
				<span class="arrow">from</span>
			{/if}
			{@render directory(previous.directory ? `${previous.directory}/` : "./")}
			{#if !tree}
				<span class="arrow">→</span>
				{@render directory(current.directory ? `${current.directory}/` : "./")}
			{/if}
		</span>
	{:else if !tree && current.directory}
		<span class="context">{@render directory(current.directory)}</span>
	{/if}
</span>

<style>
.file-label,
.names,
.context {
	display: flex;
	align-items: baseline;
	min-width: 0;
	overflow: hidden;
	gap: var(--space-1);
}

.file-label {
	flex: 1;
}

.context {
	flex: 1 1 0;
	color: var(--color-text-muted);
}

.leaf,
.directory {
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

/* Clip the far end of a directory prefix (or an overlong basename) first.
   The isolated text keeps its own reading direction, including in RTL names. */
.leaf,
.directory {
	direction: rtl;
	text-align: left;
}

.former {
	flex: 1 1 0;
	min-width: 2ch;
	max-width: max-content;
	color: var(--color-text-muted);
	direction: ltr;
}

.arrow {
	flex: none;
	color: var(--color-text-muted);
}
</style>
