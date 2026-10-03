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
	style="
    position: absolute;
    top: 0;
    right: 8px;
    z-index: 10;
    width: 300px;
    height: var(--control-lg-h);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
    display: flex;
    align-items: center;
    padding: 0 var(--space-2);
    gap: var(--space-1);
  "
>
	<input
		class="search-bar-input"
		type="text"
		placeholder="Search commits…"
		bind:value={inputValue}
		oninput={handleInput}
		onkeydown={handleKeydown}
		use:autofocus
		style="
      flex: 1;
      border: none;
      background: transparent;
      font-size: var(--text-body);
      color: var(--color-text);
      outline: none;
      min-width: 0;
    "
	>

	{#if query.length > 0}
		<span
			style="
        flex-shrink: 0;
        font-size: var(--text-small);
        color: var(--color-text-muted);
        white-space: nowrap;
      "
		>
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
