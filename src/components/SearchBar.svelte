<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import X from "@lucide/svelte/icons/x";
import { slide } from "svelte/transition";
import Button from "../lib/ui/Button.svelte";

interface Props {
	query: string;
	currentIndex: number;
	totalMatches: number;
	onquerychange: (query: string) => void;
	onnext: () => void;
	onprev: () => void;
	onclose: () => void;
}

let {
	query,
	currentIndex,
	totalMatches,
	onquerychange,
	onnext,
	onprev,
	onclose,
}: Props = $props();

let inputValue = $state("");

// Sync local input state with the query prop
$effect(() => {
	inputValue = query;
});

function handleInput() {
	onquerychange(inputValue);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		onclose();
	} else if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		onprev();
	} else if (e.key === "Enter") {
		e.preventDefault();
		onnext();
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}
</script>

<div
	transition:slide={{ duration: 150, axis: 'y' }}
	class="absolute top-0 right-2 z-10 search-bar h-control-lg bg-surface-raised border border-border rounded shadow-md flex items-center py-0 px-2 gap-1"
>
	<input
		class="search-bar-input flex-1 border-none bg-transparent text-body text-text outline-none min-w-0"
		type="text"
		placeholder="Search commits…"
		bind:value={inputValue}
		oninput={handleInput}
		onkeydown={handleKeydown}
		use:autofocus
	>

	{#if query.length > 0}
		<span class="shrink-0 text-small text-text-muted whitespace-nowrap">
			{#if totalMatches > 0}
				{`${currentIndex + 1} of ${totalMatches}`}
			{:else}
				0 matches
			{/if}
		</span>
	{/if}

	<Button
		icon
		size="sm"
		variant="ghost"
		aria-label="Previous match"
		disabled={totalMatches === 0}
		onclick={onprev}
	>
		<ChevronUp size={14} />
	</Button>

	<Button
		icon
		size="sm"
		variant="ghost"
		aria-label="Next match"
		disabled={totalMatches === 0}
		onclick={onnext}
	>
		<ChevronDown size={14} />
	</Button>

	<Button
		icon
		size="sm"
		variant="ghost"
		aria-label="Close search"
		onclick={onclose}
	>
		<X size={14} />
	</Button>
</div>

<style>
.search-bar {
	width: calc(75 * var(--u));
}
</style>
