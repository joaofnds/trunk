<script lang="ts">
import { showFilePathMenu } from "../lib/file-menu.js";
import { fileKey, toFileStatusList } from "../lib/file-status.js";
import { filterShortcut } from "../lib/filter-shortcut.js";
import { createPathFilter } from "../lib/path-filter.js";
import type {
	DiffStat,
	FileDiff,
	FileStatus,
	ReviewTally,
} from "../lib/types.js";
import FileViewControls from "./FileViewControls.svelte";
import ListFilter from "./ListFilter.svelte";
import TreeFileList from "./TreeFileList.svelte";

let {
	fileDiffs,
	stat,
	selectedFile,
	onfileselect,
	treeViewEnabled,
	ontreeviewtoggle,
	repoPath,
	onhistory,
	commentCounts,
	commentTallies,
	fill = false,
}: {
	fileDiffs: FileDiff[];
	stat: DiffStat | null;
	selectedFile: string | null;
	onfileselect: (path: string) => void;
	treeViewEnabled: boolean;
	ontreeviewtoggle?: () => void;
	repoPath: string;
	onhistory?: (key: string) => void;
	commentCounts?: Map<string, number>;
	commentTallies?: Map<string, ReviewTally>;
	fill?: boolean;
} = $props();

let query = $state("");
let open = $state(false);
let filter: ListFilter;
let tree = $state<TreeFileList | null>(null);
const files = $derived(toFileStatusList(fileDiffs));
const filterPaths = $derived(createPathFilter(files));
const matches = $derived(filterPaths(query));

function showContextMenu(
	anchor: DOMRect | undefined,
	path: string,
	file: FileStatus,
) {
	void showFilePathMenu({
		anchor,
		repoPath,
		path,
		oldPath: file.old_path,
		onhistory: onhistory && (() => onhistory?.(fileKey(file))),
	});
}
</script>

<div
	class={fill ? "flex min-h-0 flex-1 flex-col" : undefined}
	use:filterShortcut={() => filter.focus()}
>
	<div
		class="min-h-bar py-1 px-3 flex items-center gap-1 shadow-hairline shrink-0"
		class:flex-wrap={open && treeViewEnabled}
	>
		<div
			class={open
				? "shrink-0"
				: "min-w-0 flex-1 flex flex-wrap items-center justify-between gap-x-1"}
		>
			<span
				aria-live="polite"
				class={open
					? "text-small tabular-nums text-text-muted shrink-0"
					: "text-callout font-medium text-text"}
			>
				{#if open}
					<span class="sr-only"
						>{matches.length} of {files.length}
						{files.length === 1 ? "file" : "files"} changed</span
					>
					<span aria-hidden="true">{matches.length} / {files.length}</span>
				{:else}
					{files.length} {files.length === 1 ? "file" : "files"} changed
				{/if}
			</span>
			{#if !open && stat && (stat.insertions > 0 || stat.deletions > 0)}
				<span class="inline-flex flex-wrap gap-x-2 font-mono text-caption">
					{#if stat.insertions > 0}
						<span class="text-diff-add">+{stat.insertions}</span>
					{/if}
					{#if stat.deletions > 0}
						<span class="text-diff-delete">−{stat.deletions}</span>
					{/if}
				</span>
			{/if}
		</div>
		<div
			class="flex items-center gap-1"
			class:filter-controls={open}
			class:min-w-0={open}
			class:shrink-0={!open}
		>
			<ListFilter
				bind:this={filter}
				label="Filter files"
				bind:query
				bind:open
			/>
			<FileViewControls
				treeMode={treeViewEnabled}
				expansion={tree?.directoryExpansion() ?? "empty"}
				onsetexpanded={(expanded) => tree?.setDirectoriesExpanded(expanded)}
				onbulkkeydown={(event) => filter?.handleKeydown(event)}
				onviewtoggle={ontreeviewtoggle}
			/>
		</div>
	</div>
	{#if query && !matches.length}
		<p class="px-3 py-2 text-small text-text-muted">No matching files</p>
	{/if}
	<TreeFileList
		bind:this={tree}
		files={matches}
		filterQuery={query}
		treeMode={treeViewEnabled}
		actionLabel=""
		onfileaction={() => {}}
		onfileclick={onfileselect}
		selectedPath={selectedFile}
		onfilecontextmenu={showContextMenu}
		{commentCounts}
		{commentTallies}
	/>
</div>

<style>
.filter-controls {
	flex: 1 1 max-content;
}
</style>
