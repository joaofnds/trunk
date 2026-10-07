<script lang="ts">
// Which threads the review panel and the diff show, as a select-only combobox:
// the focus stays on the trigger, the arrow keys move the active option, and
// Enter or a click chooses it. Each option carries its state's glyph and how
// many threads it would show, so a reader sees where the work is before
// filtering to it.
import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
import { REVIEW_FILTER_OPTIONS } from "../../lib/review-filter.js";
import type { ReviewFilter } from "../../lib/types.js";
import ListOption from "../../lib/ui/ListOption.svelte";
import StateGlyph from "./StateGlyph.svelte";

type ShownFilter = Exclude<ReviewFilter, "none">;

interface Props {
	value: ShownFilter;
	/** How many threads each filter would show. */
	counts?: Partial<Record<ShownFilter, number>>;
	onchange: (filter: ShownFilter) => void;
}

let { value, counts = {}, onchange }: Props = $props();

const id = $props.id();
const options = REVIEW_FILTER_OPTIONS.filter(
	(option): option is { value: ShownFilter; label: string } =>
		option.value !== "none",
);

let open = $state(false);
let active = $state(0);
let root = $state<HTMLElement | null>(null);

const current = $derived(
	options.find((option) => option.value === value) ?? options[0],
);

function optionId(index: number): string {
	return `${id}-option-${index}`;
}

function openList() {
	active = Math.max(
		0,
		options.findIndex((option) => option.value === value),
	);
	open = true;
}

function toggle() {
	if (open) open = false;
	else openList();
}

function choose(index: number) {
	open = false;
	const next = options[index].value;
	if (next !== value) onchange(next);
}

function handleKeydown(event: KeyboardEvent) {
	if (!open) {
		if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
			event.preventDefault();
			openList();
		}
		return;
	}
	if (event.key === "ArrowDown")
		active = Math.min(active + 1, options.length - 1);
	else if (event.key === "ArrowUp") active = Math.max(active - 1, 0);
	else if (event.key === "Home") active = 0;
	else if (event.key === "End") active = options.length - 1;
	else if (event.key === "Enter" || event.key === " ") choose(active);
	else if (event.key === "Escape" || event.key === "Tab") {
		open = false;
		if (event.key === "Tab") return;
	} else return;
	event.preventDefault();
}

$effect(() => {
	if (!open) return;
	const close = (event: PointerEvent) => {
		if (!root?.contains(event.target as Node)) open = false;
	};
	window.addEventListener("pointerdown", close, true);
	return () => window.removeEventListener("pointerdown", close, true);
});
</script>

<div class="review-filter-menu" bind:this={root}>
	<div
		role="combobox"
		tabindex="0"
		class="review-filter-trigger"
		aria-label="Review filter selection"
		aria-haspopup="listbox"
		aria-describedby="{id}-help"
		aria-expanded={open}
		aria-controls={open ? `${id}-listbox` : undefined}
		aria-activedescendant={open ? optionId(active) : undefined}
		title="Which threads show in the review panel and the diff"
		onclick={toggle}
		onkeydown={handleKeydown}
	>
		{#if current.value !== "all"}
			<span
				class="review-filter-glyph"
				style:color="var(--color-thread-{current.value})"
				><StateGlyph state={current.value} size={11} /></span
			>
		{/if}
		<span>{current.label}</span>
		<ChevronsUpDown size={12} aria-hidden="true" class="text-text-muted" />
	</div>

	<span id="{id}-help" class="sr-only">
		All threads shows every card; its badges count only open and addressed
		threads. Other filters show matching thread states. Use the review threads
		button to hide review content and creation controls.
	</span>

	{#if open}
		<div
			id="{id}-listbox"
			role="listbox"
			aria-label="Review filter"
			class="review-filter-list"
		>
			{#each options as option, index (option.value)}
				{#if index === 1 || option.value === "stale"}
					<div class="review-filter-separator" aria-hidden="true"></div>
				{/if}
				<ListOption
					id={optionId(index)}
					selected={option.value === value}
					tabindex={-1}
					data-active={index === active}
					onpointerenter={() => (active = index)}
					onclick={() => choose(index)}
				>
					<span
						class="review-filter-glyph"
						style:color="var(--color-thread-{option.value})"
						>{#if option.value !== "all"}
							<StateGlyph state={option.value} size={11} />
						{/if}</span
					>
					<span class="flex-1">{option.label}</span>
					<span class="review-filter-count">{counts[option.value] ?? 0}</span>
				</ListOption>
			{/each}
		</div>
	{/if}
</div>

<style>
.review-filter-menu {
	position: relative;
	display: flex;
}

.review-filter-trigger {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	height: var(--control-h);
	padding: 0 var(--space-2);
	border-radius: var(--radius);
	color: var(--color-text-strong);
	font-size: var(--text-small);
	white-space: nowrap;
	cursor: pointer;
}
.review-filter-trigger:focus-visible {
	outline: 2px solid var(--color-accent);
	outline-offset: -2px;
}

.review-filter-glyph {
	display: inline-flex;
	width: calc(3 * var(--u));
	flex-shrink: 0;
}

.review-filter-list {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 100;
	margin-top: var(--space-1);
	min-width: calc(45 * var(--u));
	padding: var(--space-1) 0;
	background: var(--color-surface-raised);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	box-shadow: var(--shadow-md);
	font-size: var(--text-callout);
}
.review-filter-list :global([data-active="true"]) {
	background: var(--color-hover);
}

.review-filter-separator {
	height: 1px;
	margin: var(--space-1) 0;
	background: var(--color-border);
}

.review-filter-count {
	color: var(--color-text-subtle);
	font-family: var(--font-mono);
	font-size: var(--text-small);
	font-variant-numeric: tabular-nums;
}
</style>
