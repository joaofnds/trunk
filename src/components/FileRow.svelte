<script lang="ts">
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import { treeIndent } from "../lib/chrome-heights.js";
import { renamePartsOf } from "../lib/rename-display.js";
import { STATUS_BADGES, UNKNOWN_STATUS_BADGE } from "../lib/status-badges.js";
import type { FileStatus, ReviewTally } from "../lib/types.js";
import Row, { type RowRole } from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import CommentBadge from "./CommentBadge.svelte";

interface Props {
	file: FileStatus;
	/** `option` in a flat list, `treeitem` in a tree, whatever its depth. */
	role: RowRole;
	isLoading?: boolean;
	actionLabel: string;
	onaction: () => void;
	onclick?: () => void;
	/** Called when its button takes the focus, which the list takes back. */
	onfocus?: () => void;
	oncontextmenu?: (e: MouseEvent) => void;
	depth?: number;
	displayName?: string;
	focused?: boolean;
	commentCount?: number;
	commentTally?: ReviewTally | null;
}

let {
	file,
	role,
	isLoading = false,
	actionLabel,
	onaction,
	onclick,
	onfocus,
	oncontextmenu,
	depth = 0,
	displayName,
	focused = false,
	commentCount = 0,
	commentTally = null,
}: Props = $props();

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

function openMenu(e: MouseEvent) {
	if (!oncontextmenu) return;

	e.preventDefault();
	oncontextmenu(e);
}
</script>

{#snippet action()}
	<RowAction
		size="compact"
		tone={actionLabel === '+' ? 'success' : 'danger'}
		onclick={() => onaction()}
		oncontextmenu={openMenu}
		aria-label={actionLabel === '+' ? 'Stage file' : 'Unstage file'}
	>
		{#if actionLabel === '+'}
			<Plus size={11} />
		{:else}
			<Minus size={11} />
		{/if}
	</RowAction>
{/snippet}

<Row
	data-testid="staging-file"
	variant="item"
	{role}
	selected={focused}
	tone={isLoading ? 'muted' : 'plain'}
	indent={treeIndent(depth)}
	tabindex={-1}
	aria-level={role === 'treeitem' ? depth + 1 : undefined}
	onclick={() => onclick?.()}
	onfocus={() => onfocus?.()}
	oncontextmenu={openMenu}
	actions={!isLoading && actionLabel ? action : undefined}
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
	<CommentBadge count={commentCount} tally={commentTally} />
</Row>

<style>
.path-min {
	min-width: 2ch;
}
</style>
