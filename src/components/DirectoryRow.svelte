<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import type { DirectoryNode } from "../lib/build-tree.js";
import {
	countFiles,
	sumCommentsInSubtree,
	toneInSubtree,
} from "../lib/build-tree.js";
import { treeIndent } from "../lib/chrome-heights.js";
import type { ReviewTone } from "../lib/types.js";
import RowAction from "../lib/ui/RowAction.svelte";
import CommentBadge from "./CommentBadge.svelte";

interface Props {
	node: DirectoryNode;
	depth: number;
	expanded: boolean;
	focused: boolean;
	ontoggle: () => void;
	actionLabel?: string;
	onaction?: () => void;
	oncontextmenu?: (e: MouseEvent) => void;
	commentCounts?: Map<string, number>;
	commentTones?: Map<string, ReviewTone>;
}

let {
	node,
	depth,
	expanded,
	focused,
	ontoggle,
	actionLabel = "",
	onaction,
	oncontextmenu,
	commentCounts,
	commentTones,
}: Props = $props();

let hovered = $state(false);

let fileCount = $derived(countFiles(node.children));

// Collapsed-only rollup: an expanded directory's comments already show on its
// visible descendant rows, so showing a sum too would double-read.
let commentCount = $derived(
	commentCounts ? sumCommentsInSubtree(node.children, commentCounts) : 0,
);
let commentTone = $derived(
	commentTones ? toneInSubtree(node.children, commentTones) : null,
);
</script>

<div
	role="treeitem"
	aria-expanded={expanded}
	aria-selected={focused}
	aria-level={depth + 1}
	tabindex="0"
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	onclick={ontoggle}
	onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggle(); } }}
	oncontextmenu={(e) => { if (oncontextmenu) { e.preventDefault(); oncontextmenu(e); } }}
	class="h-row flex items-center gap-1 cursor-pointer text-text text-callout"
	style:padding="0 var(--space-2) 0 {treeIndent(depth)}"
	style:background={focused ? 'var(--color-selected-row)' : hovered ? 'var(--color-surface)' : 'transparent'}
>
	<span class="inline-flex items-center text-text-muted w-3 min-w-3">
		{#if expanded}
			<ChevronDown size={12} />
		{:else}
			<ChevronRight size={12} />
		{/if}
	</span>
	<span class="overflow-hidden text-ellipsis whitespace-nowrap font-medium"
		>{node.name}</span
	>
	<span class="text-text-muted text-small font-regular shrink-0"
		>({fileCount})</span
	>
	<span class="flex-1"></span>
	{#if !expanded}
		<CommentBadge count={commentCount} tone={commentTone} />
	{/if}
	{#if hovered && actionLabel && onaction}
		<RowAction
			size="compact"
			tone={actionLabel === '+' ? 'success' : 'danger'}
			onclick={(e) => { e.stopPropagation(); onaction(); }}
			aria-label={actionLabel === '+' ? 'Stage directory' : 'Unstage directory'}
		>
			{#if actionLabel === '+'}
				<Plus size={11} />
			{:else}
				<Minus size={11} />
			{/if}
		</RowAction>
	{/if}
</div>
