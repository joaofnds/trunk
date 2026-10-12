<script lang="ts">
// The actions on a hunk's header. They render as siblings with no wrapper, so
// the header's flex row lays them out.
// Only an in-flight operation disables a staging button. Staging rebuilds the
// diff with the view options the hunk was rendered under, so a hunk index names
// the same hunk on both sides, even with whitespace ignored (TRUNK-73).
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import Button from "../../lib/ui/Button.svelte";

interface Props {
	path: string;
	hunkIdx: number;
	diffKind: PanelDiffKind;
	hasSelection: boolean;
	selectedCount: number;
	takesComments: boolean;
	isMerge: boolean;
	hunkOperationInFlight: boolean;
	onstagehunk: (filePath: string, hunkIndex: number) => void;
	onunstagehunk: (filePath: string, hunkIndex: number) => void;
	ondiscardhunk: (filePath: string, hunkIndex: number) => void;
	onstagelines: (filePath: string, hunkIndex: number) => void;
	onunstagelines: (filePath: string, hunkIndex: number) => void;
	ondiscardlines: (filePath: string, hunkIndex: number) => void;
	oncommentlines: (filePath: string, hunkIndex: number) => void;
	oncommenthunk: (filePath: string, hunkIndex: number) => void;
}

let {
	path,
	hunkIdx,
	diffKind,
	hasSelection,
	selectedCount,
	takesComments,
	isMerge,
	hunkOperationInFlight,
	onstagehunk,
	onunstagehunk,
	ondiscardhunk,
	onstagelines,
	onunstagelines,
	ondiscardlines,
	oncommentlines,
	oncommenthunk,
}: Props = $props();
</script>

{#if diffKind === 'unstaged' || diffKind === 'staged'}
	{#if takesComments}
		<Button
			size="sm"
			variant="accent"
			onclick={() => hasSelection ? oncommentlines(path, hunkIdx) : oncommenthunk(path, hunkIdx)}
		>
			{hasSelection ? `Comment (${selectedCount})` : 'Comment'}
		</Button>
	{/if}
	{#if diffKind === 'unstaged'}
		<Button
			size="sm"
			variant="danger"
			disabled={hunkOperationInFlight}
			onclick={() => hasSelection ? ondiscardlines(path, hunkIdx) : ondiscardhunk(path, hunkIdx)}
		>
			{hasSelection ? `Discard Lines (${selectedCount})` : 'Discard Hunk'}
		</Button>
		<Button
			size="sm"
			variant="success"
			disabled={hunkOperationInFlight}
			onclick={() => hasSelection ? onstagelines(path, hunkIdx) : onstagehunk(path, hunkIdx)}
		>
			{hasSelection ? `Stage Lines (${selectedCount})` : 'Stage Hunk'}
		</Button>
	{:else}
		<Button
			size="sm"
			variant="warning"
			disabled={hunkOperationInFlight}
			onclick={() => hasSelection ? onunstagelines(path, hunkIdx) : onunstagehunk(path, hunkIdx)}
		>
			{hasSelection ? `Unstage Lines (${selectedCount})` : 'Unstage Hunk'}
		</Button>
	{/if}
{:else if diffKind === 'commit' && takesComments}
	<Button
		size="sm"
		variant="accent"
		disabled={isMerge}
		title={isMerge ? "Diff comments aren't available on merge commits" : ""}
		onclick={() => hasSelection ? oncommentlines(path, hunkIdx) : oncommenthunk(path, hunkIdx)}
	>
		{hasSelection ? `Comment (${selectedCount})` : 'Comment'}
	</Button>
{/if}
