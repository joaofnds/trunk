<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import type { DirectoryNode } from "../lib/build-tree.js";
import {
	countFiles,
	sumCommentsInSubtree,
	tallyInSubtree,
} from "../lib/build-tree.js";
import { treeIndent } from "../lib/chrome-heights.js";
import type { ReviewTally } from "../lib/types.js";
import Row from "../lib/ui/Row.svelte";
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
	commentTallies?: Map<string, ReviewTally>;
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
	commentTallies,
}: Props = $props();

let fileCount = $derived(countFiles(node.children));

// Collapsed-only rollup: an expanded directory's comments already show on its
// visible descendant rows, so showing a sum too would double-read.
let commentCount = $derived(
	commentCounts ? sumCommentsInSubtree(node.children, commentCounts) : 0,
);
let commentTally = $derived(
	commentTallies ? tallyInSubtree(node.children, commentTallies) : null,
);

// WebKit leaves a clicked button unfocused, and the focus is what sends Enter
// and Space to this directory instead of to the list's cursor.
function toggle(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
	e.currentTarget.focus({ preventScroll: true });
	ontoggle();
}

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
		onclick={() => onaction?.()}
		oncontextmenu={openMenu}
		aria-label={actionLabel === '+' ? 'Stage directory' : 'Unstage directory'}
	>
		{#if actionLabel === '+'}
			<Plus size={11} />
		{:else}
			<Minus size={11} />
		{/if}
	</RowAction>
{/snippet}

<Row
	variant="parent"
	role="treeitem"
	selected={focused}
	indent={treeIndent(depth)}
	tabindex={-1}
	aria-expanded={expanded}
	aria-level={depth + 1}
	onclick={toggle}
	oncontextmenu={openMenu}
	actions={actionLabel && onaction ? action : undefined}
	reveal="pointer"
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
		<CommentBadge count={commentCount} tally={commentTally} />
	{/if}
</Row>
