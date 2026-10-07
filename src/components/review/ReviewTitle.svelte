<script lang="ts">
// A review's title as text, with each date held on one line.
import { titleRuns } from "../../lib/review-title.js";

interface Props {
	title: string;
}

let { title }: Props = $props();
</script>

{#each titleRuns(title) as run, i (i)}
	{#if run.whole}
		<span class="whitespace-nowrap">{run.text}</span>
	{:else}
		{run.text}
	{/if}
{/each}
