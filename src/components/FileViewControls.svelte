<script lang="ts">
import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import Button from "../lib/ui/Button.svelte";
import type { DirectoryExpansion } from "./TreeFileList.svelte";

let {
	treeMode,
	expansion,
	onsetexpanded,
	onbulkkeydown,
	onviewtoggle,
}: {
	treeMode: boolean;
	expansion: DirectoryExpansion;
	onsetexpanded: (expanded: boolean) => void;
	onbulkkeydown: (event: KeyboardEvent) => void;
	onviewtoggle?: () => void;
} = $props();

const shouldExpand = $derived(expansion !== "expanded");
const bulkLabel = $derived(
	shouldExpand ? "Expand all directories" : "Collapse all directories",
);
</script>

{#if treeMode || onviewtoggle}
	<div class="flex shrink-0 gap-1">
		{#if treeMode}
			<Button
				icon
				size="sm"
				variant="ghost"
				tabindex={0}
				aria-label={bulkLabel}
				tooltip={bulkLabel}
				disabled={expansion === "empty"}
				onclick={() => onsetexpanded(shouldExpand)}
				onkeydown={onbulkkeydown}
			>
				{#if shouldExpand}
					<ChevronsUpDown size={14} />
				{:else}
					<ChevronsDownUp size={14} />
				{/if}
			</Button>
		{/if}
		{#if onviewtoggle}
			<Button
				icon
				size="sm"
				variant="ghost"
				tabindex={0}
				role="switch"
				aria-checked={treeMode}
				aria-label={treeMode ? "Switch to list view" : "Switch to tree view"}
				title={treeMode ? "List view" : "Tree view"}
				onclick={onviewtoggle}
			>
				{#if treeMode}
					<FolderTree size={14} />
				{:else}
					<List size={14} />
				{/if}
			</Button>
		{/if}
	</div>
{/if}
