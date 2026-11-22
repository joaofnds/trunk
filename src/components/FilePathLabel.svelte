<script lang="ts">
import { getFileLabelStyle } from "../lib/file-label-style.svelte.js";
import { splitFilePath } from "../lib/file-path.js";

interface Props {
	path: string;
	oldPath?: string | null;
	tree?: boolean;
}

let { path, oldPath = null, tree = false }: Props = $props();

const style = getFileLabelStyle();
let fullPath = $derived(!tree && style.current === "full-path");
let current = $derived(splitFilePath(path));
let previous = $derived(oldPath === null ? null : splitFilePath(oldPath));
let moved = $derived(
	!fullPath && previous !== null && previous.directory !== current.directory,
);
let from = $derived(fullPath ? oldPath : previous?.name);
let to = $derived(fullPath ? path : current.name);
let title = $derived(oldPath === null ? path : `${oldPath} → ${path}`);
</script>

{#snippet directory(value: string)}
	<span class="directory"><bdi>{value}</bdi></span>
{/snippet}

<span class="file-label text-small" {title}>
	<span class="names text-callout">
		{#if from && from !== to}
			<span class="leaf former"><bdi>{from}</bdi></span>
			<span class="arrow">→</span>
		{/if}
		<span class="leaf" class:font-semibold={!fullPath}><bdi>{to}</bdi></span>
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
	{:else if !tree && !fullPath && current.directory}
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
}

.names,
.context {
	gap: var(--space-1);
}

.file-label {
	flex: 1;
	gap: var(--space-2);
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
