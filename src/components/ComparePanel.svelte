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
	<div style="min-width: 0;">
		<div
			style="
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    "
			>{commit.summary}</div
		>
		<div
			style="display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-1); min-width: 0; font-size: var(--text-small);"
		>
			<Avatar name={commit.author_name} size={18} />
			<span
				style="color: var(--color-text-strong); font-weight: var(--weight-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
				>{commit.author_name}</span
			>
			<span
				style="color: var(--color-text-subtle); font-family: var(--font-mono); flex-shrink: 0;"
				use:exactDate={commit.author_timestamp}
				>{relativeLabel(commit.author_timestamp, currentMinute())}</span
			>
			<span style="flex: 1;"></span>
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

<div
	style="
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--color-surface);
"
>
	<!-- Toolbar -->
	<div
		style="
    height: var(--bar-h);
    box-shadow: inset 0 -1px 0 var(--color-border);
    padding: 0 var(--space-2);
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
  "
	>
		<span
			style="
      font-size: var(--text-small);
      color: var(--color-text-muted);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    "
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
	<div
		data-testid="compare-header"
		style="
    padding: var(--space-3);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  "
	>
		{#if base}
			{@render commitCard(base)}
		{:else}
			<div
				style="
        font-size: var(--text-callout);
        font-style: italic;
        color: var(--color-text-muted);
      "
				>empty tree</div
			>
		{/if}
		<div
			aria-hidden="true"
			style="display: flex; align-items: center; gap: var(--space-2); margin: var(--space-2) 0; color: var(--color-text-muted);"
		>
			<span style="flex: 1; border-top: 1px solid var(--color-border);"></span>
			<ArrowDown size={13} />
			<span style="flex: 1; border-top: 1px solid var(--color-border);"></span>
		</div>
		{@render commitCard(target)}
	</div>

	<!-- File list, headed by the same stats bar CommitDetail uses -->
	<div
		style="
    height: var(--bar-h);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    box-shadow: inset 0 -1px 0 var(--color-border);
    flex-shrink: 0;
  "
	>
		<span
			style="font-size: var(--text-callout); font-weight: var(--weight-medium); color: var(--color-text); flex: 1;"
		>
			{`${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`}
		</span>
		{#if stat && (stat.insertions > 0 || stat.deletions > 0)}
			<span
				style="display: inline-flex; gap: var(--space-2); flex-shrink: 0; margin-right: var(--space-2); font-family: var(--font-mono); font-size: var(--text-caption);"
			>
				{#if stat.insertions > 0}
					<span style="color: var(--color-diff-add);">+{stat.insertions}</span>
				{/if}
				{#if stat.deletions > 0}
					<span style="color: var(--color-diff-delete);"
						>−{stat.deletions}</span
					>
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
	<div style="flex: 1; overflow-y: auto; min-height: 0;">
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
