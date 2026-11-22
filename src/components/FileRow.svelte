<script lang="ts">
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import { treeIndent } from "../lib/chrome-heights.js";
import { singleClick } from "../lib/single-click.js";
import { STATUS_BADGES, UNKNOWN_STATUS_BADGE } from "../lib/status-badges.js";
import type { FileStatus, ReviewTally } from "../lib/types.js";
import Row, { type RowRole } from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import CommentBadge from "./CommentBadge.svelte";
import FilePathLabel from "./FilePathLabel.svelte";

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
	selected?: boolean;
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
	selected = false,
	commentCount = 0,
	commentTally = null,
}: Props = $props();

let badge = $derived(STATUS_BADGES[file.status] ?? UNKNOWN_STATUS_BADGE);

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
		tone={actionLabel === "+" ? "success" : "danger"}
		onclick={(e: MouseEvent) => singleClick(e, onaction)}
		oncontextmenu={openMenu}
		aria-label={actionLabel === "+" ? "Stage file" : "Unstage file"}
	>
		{#if actionLabel === "+"}
			<Plus size={11} />
		{:else}
			<Minus size={11} />
		{/if}
	</RowAction>
{/snippet}

<Row
	data-testid="staging-file"
	data-path={file.path}
	variant="item"
	{role}
	{selected}
	tone={isLoading ? "muted" : "plain"}
	indent={treeIndent(depth)}
	tabindex={-1}
	aria-level={role === "treeitem" ? depth + 1 : undefined}
	aria-description={role === "treeitem" ? file.path : undefined}
	onclick={() => onclick?.()}
	onfocus={() => onfocus?.()}
	oncontextmenu={openMenu}
	actions={!isLoading && actionLabel ? action : undefined}
>
	<!-- Status badge -->
	<span
		class="shrink-0 inline-flex items-center justify-center size-4 rounded font-mono font-semibold text-caption leading-none"
		style:color={isLoading ? "var(--color-text-muted)" : badge.color}
		style:background={badgeBg}
		>{badge.letter}</span
	>

	<FilePathLabel
		path={file.path}
		oldPath={file.old_path}
		tree={role === "treeitem"}
	/>

	<!-- Review-comment count for this file -->
	<CommentBadge count={commentCount} tally={commentTally} />
</Row>
