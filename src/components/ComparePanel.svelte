<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUpDown from "@lucide/svelte/icons/arrow-up-down";
import X from "@lucide/svelte/icons/x";
import { copySha } from "../lib/clipboard.js";
import { exactDate } from "../lib/exact-date.js";
import { currentMinute } from "../lib/now.svelte.js";
import { relativeLabel } from "../lib/relative-time.js";
import type { CommitDetail, DiffStat, FileDiff } from "../lib/types.js";
import Badge from "../lib/ui/Badge.svelte";
import Button from "../lib/ui/Button.svelte";
import Avatar from "./Avatar.svelte";
import ChangedFileList from "./ChangedFileList.svelte";

interface Props {
	/** Left/old side of the compare; null is the empty tree (root-based range). */
	base: CommitDetail | null;
	repoPath?: string;
	onhistory?: (path: string) => void;
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
	repoPath = "",
	onhistory,
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
</script>

{#snippet commitCard(commit: CommitDetail)}
	<div class="min-w-0">
		<div
			title={commit.summary}
			class="text-body font-semibold text-text line-clamp-2 wrap-anywhere"
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
			<Badge title="Copy SHA" onclick={() => copySha(commit.oid)}
				>{commit.short_oid}</Badge
			>
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

	{#key `${base?.oid ?? ""}/${target.oid}`}
		<ChangedFileList
			fill
			{repoPath}
			{onhistory}
			{fileDiffs}
			{stat}
			{selectedFile}
			{onfileselect}
			{treeViewEnabled}
			{ontreeviewtoggle}
		/>
	{/key}
</div>
