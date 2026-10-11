<script lang="ts">
import { untrack } from "svelte";
import CommitGraph from "../../components/CommitGraph.svelte";
import Button from "../../lib/ui/Button.svelte";

let {
	refreshSignal = 0,
	visible = true,
	visibilityResolved = true,
	withWip = false,
	onconsumed,
}: {
	refreshSignal?: number;
	visible?: boolean;
	visibilityResolved?: boolean;
	withWip?: boolean;
	onconsumed?: (generation: number) => void;
} = $props();
let consumedRefreshSignal = $state(0);
let wipCount = $state(untrack(() => (withWip ? 1 : 0)));
</script>

{#if withWip}
	<Button onclick={() => { wipCount = 0; }}>Clear WIP</Button>
{/if}

{#if visible}
	<CommitGraph
		repoPath="/repo"
		tabActive={true}
		{refreshSignal}
		{consumedRefreshSignal}
		{visibilityResolved}
		{wipCount}
		onrefreshconsumed={(generation) => { consumedRefreshSignal = Math.max(consumedRefreshSignal, generation); onconsumed?.(generation); }}
	/>
{/if}
