<script lang="ts">
import { untrack } from "svelte";
import CommitGraph from "../../components/CommitGraph.svelte";
import Button from "../../lib/ui/Button.svelte";

let {
	refreshSignal = 0,
	wipRefreshSignal = 0,
	refreshImmediately = false,
	commandTarget,
	visible = true,
	visibilityResolved = true,
	withWip = false,
	onconsumed,
}: {
	refreshSignal?: number;
	wipRefreshSignal?: number;
	refreshImmediately?: boolean;
	commandTarget?: "graph" | "worktree";
	visible?: boolean;
	visibilityResolved?: boolean;
	withWip?: boolean;
	onconsumed?: (generation: number) => void;
} = $props();
let commandGeneration = $state(0);
let consumedRefreshSignal = $state(0);
let wipCount = $state(untrack(() => (withWip ? 1 : 0)));
</script>

{#if commandTarget}
	<Button
		onclick={() => {
			commandGeneration += 1;
		}}
		>Complete command</Button
	>
{/if}

{#if withWip}
	<Button
		onclick={() => {
			wipCount = 0;
		}}
		>Clear WIP</Button
	>
{/if}

{#if visible}
	<CommitGraph
		repoPath="/repo"
		tabActive={true}
		commentCounts={new Map()}
		commentTallies={new Map()}
		refreshSignal={refreshSignal +
			(commandTarget === "graph" ? commandGeneration : 0)}
		wipRefreshSignal={wipRefreshSignal +
			(commandTarget === "worktree" ? commandGeneration : 0)}
		{refreshImmediately}
		{consumedRefreshSignal}
		{visibilityResolved}
		{wipCount}
		onrefreshconsumed={(generation) => {
			consumedRefreshSignal = Math.max(consumedRefreshSignal, generation);
			onconsumed?.(generation);
		}}
	/>
{/if}
