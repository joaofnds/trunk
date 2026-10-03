<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUpDown from "@lucide/svelte/icons/arrow-up-down";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import X from "@lucide/svelte/icons/x";
import { copySha } from "../lib/clipboard.js";
import { exactDate } from "../lib/exact-date.js";
import { toFileStatusList } from "../lib/file-status.js";
import { currentMinute } from "../lib/now.svelte.js";
import { relativeLabel } from "../lib/relative-time.js";
import type {
	CommitDetail,
	DiffStat,
	FileDiff,
	FileStatus,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Avatar from "./Avatar.svelte";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	/** Left/old side of the compare; null is the empty tree (root-based range). */
	base: CommitDetail | null;
	/** Right/new side of the compare. */
	target: CommitDetail;
	fileDiffs: FileDiff[];
	/** Whole-compare totals; null while they load (the bar shows counts only). */
	stat: DiffStat | null;
	selectedFile: string | null;
	onfileselect: (path: string) => void;
	onswap: () => void;
	onclose: () => void;
	treeViewEnabled?: boolean;
	ontreeviewtoggle?: () => void;
}

let {
	base,
	target,
	fileDiffs,
	stat,
	selectedFile,
	onfileselect,
	onswap,
	onclose,
	treeViewEnabled = false,
	ontreeviewtoggle,
}: Props = $props();

let fileStatusList = $derived<FileStatus[]>(toFileStatusList(fileDiffs));
// Count from the list, not stat.files_changed: the stat collapses renames the
// list splits into Deleted + Added, and the count sits right above that list.
// The stat still owns +/- — collapsed totals are the true edit size.
let filesChanged = $derived(fileDiffs.length);
</script>

{#snippet commitCard(commit: CommitDetail)}
	<div class="min-w-0">
		<div
			class="text-body font-semibold text-text overflow-hidden text-ellipsis whitespace-nowrap"
			>{commit.summary}</div
		>
		<div class="flex items-center gap-2 mt-1 min-w-0 text-small">
			<Avatar name={commit.author_name} size={18} />
			<span
				class="text-text-strong font-semibold overflow-hidden text-ellipsis whitespace-nowrap"
				>{commit.author_name}</span
			>
			<span
				class="text-text-subtle font-mono shrink-0"
				use:exactDate={commit.author_timestamp}
				>{relativeLabel(commit.author_timestamp, currentMinute())}</span
			>
			<span class="flex-1"></span>
			<span
				class="inline-flex shrink-0 items-center rounded bg-surface-chip px-2 py-1 text-small text-text-strong"
			>
				<LinkButton mono title="Copy SHA" onclick={() => copySha(commit.oid)}
					>{commit.short_oid}</LinkButton
				>
			</span>
		</div>
	</div>
{/snippet}

<div class="w-full min-w-0 flex flex-col h-full overflow-hidden bg-surface">
	<!-- Toolbar -->
	<div class="h-bar shadow-hairline py-0 px-2 flex items-center gap-1 shrink-0">
		<span
			class="text-small text-text-muted flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
			>Comparing</span
		>
		<Button
			icon
			size="sm"
			variant="ghost"
			aria-label="Swap comparison direction"
			title="Swap comparison direction"
			disabled={base === null}
			onclick={onswap}
			><ArrowUpDown size={14} /></Button
		>
		<Button
			icon
			size="sm"
			variant="ghost"
			aria-label="Close comparison"
			onclick={onclose}
			><X size={14} /></Button
		>
	</div>

	<!-- Base → Target: open blocks split by a hairline carrying the arrow -->
	<div data-testid="compare-header" class="p-3 border-b border-border shrink-0">
		{#if base}
			{@render commitCard(base)}
		{:else}
			<div class="text-callout leading-normal italic text-text-muted"
				>empty tree</div
			>
		{/if}
		<div
			aria-hidden="true"
			class="flex items-center gap-2 my-2 mx-0 text-text-muted"
		>
			<span class="flex-1 border-t border-border"></span>
			<ArrowDown size={13} />
			<span class="flex-1 border-t border-border"></span>
		</div>
		{@render commitCard(target)}
	</div>

	<!-- File list, headed by the same stats bar CommitDetail uses -->
	<div class="h-bar py-0 px-3 flex items-center shadow-hairline shrink-0">
		<span class="text-callout font-medium text-text flex-1">
			{`${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`}
		</span>
		{#if stat && (stat.insertions > 0 || stat.deletions > 0)}
			<span class="inline-flex gap-2 shrink-0 mr-2 font-mono text-caption">
				{#if stat.insertions > 0}
					<span class="text-diff-add">+{stat.insertions}</span>
				{/if}
				{#if stat.deletions > 0}
					<span class="text-diff-delete">−{stat.deletions}</span>
				{/if}
			</span>
		{/if}
		{#if ontreeviewtoggle}
			<Button
				icon
				size="sm"
				variant="ghost"
				role="switch"
				aria-checked={treeViewEnabled}
				aria-label={treeViewEnabled ? 'Switch to list view' : 'Switch to tree view'}
				title={treeViewEnabled ? 'List view' : 'Tree view'}
				onclick={(e) => { e.stopPropagation(); ontreeviewtoggle?.(); }}
			>
				{#if treeViewEnabled}
					<FolderTree size={14} />
				{:else}
					<List size={14} />
				{/if}
			</Button>
		{/if}
	</div>
	<div class="flex-1 overflow-y-auto min-h-0">
		<TreeFileList
			files={fileStatusList}
			treeMode={treeViewEnabled}
			actionLabel=""
			onfileaction={() => {}}
			onfileclick={(path) => onfileselect(path)}
			selectedPath={selectedFile}
		/>
	</div>
</div>
