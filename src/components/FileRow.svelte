<script lang="ts">
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import { treeIndent } from "../lib/chrome-heights.js";
import { renamePartsOf } from "../lib/rename-display.js";
import { STATUS_BADGES, UNKNOWN_STATUS_BADGE } from "../lib/status-badges.js";
import type { FileStatus, ReviewTone } from "../lib/types.js";
import RowAction from "../lib/ui/RowAction.svelte";
import CommentBadge from "./CommentBadge.svelte";

interface Props {
	file: FileStatus;
	isLoading?: boolean;
	actionLabel: string;
	onaction: () => void;
	onclick?: () => void;
	oncontextmenu?: (e: MouseEvent) => void;
	depth?: number;
	displayName?: string;
	focused?: boolean;
	commentCount?: number;
	commentTone?: ReviewTone | null;
}

let {
	file,
	isLoading = false,
	actionLabel,
	onaction,
	onclick,
	oncontextmenu,
	depth = 0,
	displayName,
	focused = false,
	commentCount = 0,
	commentTone = null,
}: Props = $props();

let hovered = $state(false);

let badge = $derived(STATUS_BADGES[file.status] ?? UNKNOWN_STATUS_BADGE);

// A rename names both paths in full. Tree mode has already shortened the new
// path to its basename and the tree's own nesting says where the file is, so
// the old side shortens to its basename there rather than sitting beside it at
// full length.
let rename = $derived.by(() => {
	const parts = renamePartsOf(file.path, file.old_path ?? null);
	if (parts === null || displayName === undefined) return parts;

	return {
		from: parts.from.split("/").pop() ?? parts.from,
		to: displayName,
	};
});

let badgeBg = $derived(
	isLoading
		? "transparent"
		: `color-mix(in oklch, ${badge.color} 6%, transparent)`,
);
</script>

<div
	data-testid="staging-file"
	role={depth > 0 ? 'treeitem' : 'listitem'}
	aria-level={depth > 0 ? depth + 1 : undefined}
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	onclick={() => onclick?.()}
	oncontextmenu={(e) => { if (oncontextmenu) { e.preventDefault(); oncontextmenu(e); } }}
	class="h-row flex items-center gap-2"
	style:padding="0 var(--space-2) 0 {treeIndent(depth)}"
	style:cursor={onclick ? 'pointer' : 'default'}
	style:background={focused ? 'var(--color-selected-row)' : hovered ? 'var(--color-hover)' : 'transparent'}
	style:color={isLoading ? 'var(--color-text-muted)' : 'var(--color-text)'}
>
	<!-- Status badge -->
	<span
		class="shrink-0 inline-flex items-center justify-center size-4 rounded font-mono font-semibold text-caption leading-none"
		style:color={isLoading ? 'var(--color-text-muted)' : badge.color}
		style:background={badgeBg}
		>{badge.letter}</span
	>

	<!-- Filename, or both paths when the file was renamed -->
	<span class="flex-1 min-w-0 flex items-baseline gap-1 text-callout">
		{#if rename !== null}
			<!-- The old path yields space first: it shrinks and ellipsizes while the
           new path, which is where the file is now, keeps its width. -->
			<span
				class="shrink path-min overflow-hidden text-ellipsis whitespace-nowrap text-text-muted"
				>{rename.from}</span
			>
			<span aria-hidden="true" class="shrink-0 text-text-muted">→</span>
			<span class="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
				>{rename.to}</span
			>
		{:else}
			<span class="overflow-hidden text-ellipsis whitespace-nowrap"
				>{displayName ?? file.path}</span
			>
		{/if}
	</span>

	<!-- Review-comment count for this file -->
	<CommentBadge count={commentCount} tone={commentTone} />

	<!-- Hover action button (hidden during loading or when no actionLabel) -->
	{#if hovered && !isLoading && actionLabel}
		<RowAction
			size="compact"
			tone={actionLabel === '+' ? 'success' : 'danger'}
			onclick={(e) => { e.stopPropagation(); onaction(); }}
			aria-label={actionLabel === '+' ? 'Stage file' : 'Unstage file'}
		>
			{#if actionLabel === '+'}
				<Plus size={11} />
			{:else}
				<Minus size={11} />
			{/if}
		</RowAction>
	{/if}
</div>

<style>
.path-min {
	min-width: 2ch;
}
</style>
