<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import Search from "@lucide/svelte/icons/search";
import X from "@lucide/svelte/icons/x";
import { slide } from "svelte/transition";
import { motionDuration } from "../lib/motion-duration.js";
import Button from "../lib/ui/Button.svelte";

interface Props {
	placeholder?: string;
	animate?: boolean;
	inline?: boolean;
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
	inline = false,
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
	if (e.isComposing || e.defaultPrevented) return;

	if (e.key === "Escape") {
		e.preventDefault();
		onclose();
	} else if (e.target !== input) {
		return;
	} else if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		onprev();
	} else if (e.key === "Enter") {
		e.preventDefault();
		onnext();
	}
}

let input: HTMLInputElement;
let bar: HTMLElement;
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

<search
	bind:this={bar}
	transition:slide={{ duration: animate ? motionDuration(150) : 0, axis: "y" }}
	class={[
		inline
			? "inline-finder flex-wrap border-b border-border bg-surface"
			: [
					atBottom ? "bottom-2" : "top-2",
					"floating absolute right-2 z-10 bg-surface-chip border border-border-strong rounded shadow-md",
				],
		"search-bar flex items-center pl-3 pr-1 py-1 gap-1",
	]}
>
	<label class="query-field min-w-0 flex-1 flex items-center gap-2 cursor-text">
		<Search size={14} aria-hidden="true" class="shrink-0 text-text-muted" />
		<input
			class="search-bar-input flex-1 border-none bg-transparent text-body text-text-strong caret-accent focus:outline-hidden min-w-0"
			type="text"
			{placeholder}
			aria-label={placeholder}
			bind:this={input}
			bind:value={inputValue}
			oninput={handleInput}
			onkeydown={handleKeydown}
			use:autofocus
		>
	</label>

	<div class="ml-auto flex items-center gap-1">
		{#if query.length > 0 && !searching}
			<span
				aria-live="polite"
				class="mx-1 shrink-0 text-small tabular-nums text-text-muted whitespace-nowrap"
			>
				{#if totalMatches > 0}
					{`${currentIndex + 1} of ${totalMatches}`}
				{:else}
					0 matches
				{/if}
			</span>
		{/if}

		<div class="flex gap-1 me-1">
			<Button
				icon
				size="base"
				variant="ghost"
				aria-label="Previous match"
				onkeydown={handleKeydown}
				tooltip="Previous match (Shift+Enter)"
				disabled={totalMatches === 0}
				onclick={onprev}
			>
				<ChevronUp size={14} />
			</Button>

			<Button
				icon
				size="base"
				variant="ghost"
				aria-label="Next match"
				onkeydown={handleKeydown}
				tooltip="Next match (Enter)"
				disabled={totalMatches === 0}
				onclick={onnext}
			>
				<ChevronDown size={14} />
			</Button>
		</div>

		<Button
			icon
			size="base"
			variant="ghost"
			aria-label="Close search"
			onkeydown={handleKeydown}
			tooltip="Close search (Esc)"
			onclick={onclose}
		>
			<X size={14} />
		</Button>
	</div>
</search>

<style>
.inline-finder .query-field {
	flex-basis: 16ch;
}

.search-bar.floating {
	width: calc(84 * var(--u));
	max-width: calc(100% - 2 * var(--space-2));
}
</style>
