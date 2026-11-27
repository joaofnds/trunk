<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import X from "@lucide/svelte/icons/x";
import { slide } from "svelte/transition";
import { motionDuration } from "../lib/motion-duration.js";
import Button from "../lib/ui/Button.svelte";

interface Props {
	placeholder?: string;
	animate?: boolean;
	query: string;
	currentIndex: number;
	totalMatches: number;
	/** The query has changed and its answer is not in yet, so no count is known. */
	searching: boolean;
	onquerychange: (query: string) => void;
	onnext: () => void;
	onprev: () => void;
	onclose: () => void;
}

let {
	placeholder = "Search commits…",
	animate = true,
	query,
	currentIndex,
	totalMatches,
	searching,
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
	if (e.isComposing) return;

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

let input: HTMLInputElement;
let bar: HTMLDivElement;
let atBottom = $state(false);

export function avoidCovering(mark: HTMLElement, clip: Element | null) {
	const bounds = bar.getBoundingClientRect();
	const visible = clip?.getBoundingClientRect() ?? bounds;
	if (
		Array.from(mark.getClientRects()).some(
			(rect) =>
				Math.max(rect.left, visible.left, bounds.left) <
					Math.min(rect.right, visible.right, bounds.right) &&
				rect.top < bounds.bottom &&
				rect.bottom > bounds.top,
		)
	) {
		atBottom = !atBottom;
	}
}

export function focusQuery() {
	input.focus();
	input.select();
}

function autofocus(node: HTMLElement) {
	node.focus();
}
</script>

<div
	bind:this={bar}
	transition:slide={{ duration: animate ? motionDuration(150) : 0, axis: "y" }}
	class={[
		atBottom ? "bottom-0" : "top-0",
		"search-bar absolute right-2 z-10 h-control-lg bg-surface-raised border border-border rounded shadow-md flex items-center py-0 px-2 gap-1",
	]}
>
	<input
		class="search-bar-input flex-1 border-none bg-transparent text-body text-text caret-accent focus:outline-hidden min-w-0"
		type="text"
		{placeholder}
		aria-label={placeholder}
		bind:this={input}
		bind:value={inputValue}
		oninput={handleInput}
		onkeydown={handleKeydown}
		use:autofocus
	>

	{#if query.length > 0 && !searching}
		<span
			aria-live="polite"
			class="shrink-0 text-small text-text-muted whitespace-nowrap"
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

<style>
.search-bar {
	width: calc(75 * var(--u));
	max-width: calc(100% - var(--space-2));
}

.search-bar:has(> input:focus) {
	border-color: color-mix(
		in oklch,
		var(--color-accent) 65%,
		var(--color-border)
	);
}
</style>
