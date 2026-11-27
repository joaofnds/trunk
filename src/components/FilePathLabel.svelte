<script lang="ts">
import { getFileLabelStyle } from "../lib/file-label-style.svelte.js";
import { splitFilePath } from "../lib/file-path.js";
import type { PathMatch } from "../lib/path-filter.js";
import PathMatchText from "./PathMatchText.svelte";

interface Props {
	path: string;
	oldPath?: string | null;
	tree?: boolean;
	match?: PathMatch;
}

let { path, oldPath = null, tree = false, match }: Props = $props();

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
let toOffset = $derived(path.length - to.length);
let fromOffset = $derived(oldPath && from ? oldPath.length - from.length : 0);

// A shared basename or directory is printed once for both names of a rename.
function sharedPositions(shift: number) {
	if (!match?.oldPath.length) return match?.path;

	const positions = new Set(match.path);
	for (const position of match.oldPath) positions.add(position + shift);
	return [...positions].sort((a, b) => a - b);
}

let namePositions = $derived(
	from === to ? sharedPositions(toOffset - fromOffset) : match?.path,
);
let directoryPositions = $derived(
	previous && !moved ? sharedPositions(0) : match?.path,
);
</script>

{#snippet label(text: string, positions?: readonly number[], offset = 0)}
	<bdi
		>{#if positions?.length}
			<PathMatchText {text} {positions} {offset} />
		{:else}
			{text}
		{/if}</bdi
	>
{/snippet}

{#snippet directory(value: string, positions?: readonly number[])}
	<span class="directory">
		{#if value}
			{@const suffix = moved || positions?.includes(value.length) ? "/" : ""}
			{@render label(value + suffix, positions)}
		{:else}
			<bdi>./</bdi>
		{/if}
	</span>
{/snippet}

<span class="file-label text-small" {title}>
	<span class="names text-callout">
		{#if from && from !== to}
			<span class="leaf former"
				>{@render label(from, match?.oldPath, fromOffset)}</span
			>
			<span class="arrow">→</span>
		{/if}
		<span class="leaf" class:font-semibold={!fullPath && !match}
			>{@render label(to, namePositions, toOffset)}</span
		>
	</span>
	{#if previous && moved}
		<span class="context">
			{#if tree}
				<span class="arrow">from</span>
			{/if}
			{@render directory(previous.directory, match?.oldPath)}
			{#if !tree}
				<span class="arrow">→</span>
				{@render directory(current.directory, match?.path)}
			{/if}
		</span>
	{:else if !tree && !fullPath && current.directory}
		<span class="context"
			>{@render directory(current.directory, directoryPositions)}</span
		>
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
