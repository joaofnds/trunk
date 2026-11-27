<script lang="ts">
// The changed-first fuzzy file finder (D11, plan §3). It is how a user reaches a
// file no pending change touches, which is the entry point Trunk has never had.
//
// The source list is the backend's tracked-file enumeration, so untracked and
// ignored files cannot appear here at all. The finder never reads the filesystem
// itself; picking a row reports the path and the host opens it.

import { onMount } from "svelte";
import { createFileFinder } from "../lib/file-finder.js";
import { tallyBreakdown, tallyEntries } from "../lib/review-filter.js";
import type { ReviewTally, TrackedFile } from "../lib/types.js";
import Dialog, { paletteInputClass } from "../lib/ui/Dialog.svelte";
import ListOption from "../lib/ui/ListOption.svelte";
import CommentBadge from "./CommentBadge.svelte";
import FilePathLabel from "./FilePathLabel.svelte";

interface Props {
	files: TrackedFile[] | null;
	// How many current-file comments each path already carries, so a user sees
	// where the discussion already is before opening anything.
	commentCounts?: Map<string, number>;
	commentTallies?: Map<string, ReviewTally>;
	onselect: (path: string) => void;
	onclose: () => void;
}

let {
	files,
	commentCounts = new Map<string, number>(),
	commentTallies = new Map<string, ReviewTally>(),
	onselect,
	onclose,
}: Props = $props();

const listId = "file-finder-list";
const statusId = "file-finder-status";
let query = $state("");
let selectedIndex = $state(0);
let rowHeight = $state(0);
let viewportHeight = $state(0);
let scrollTop = $state(0);
let inputEl: HTMLInputElement | undefined;
let listEl: HTMLDivElement | undefined;
let rowProbe: HTMLDivElement | undefined;

onMount(() => {
	const list = listEl;
	const probe = rowProbe;
	if (!inputEl || !list || !probe) return;

	inputEl.focus({ preventScroll: true });

	const measure = () => {
		rowHeight = probe.getBoundingClientRect().height;
		viewportHeight = list.clientHeight;
		scrollTop = list.scrollTop;
		keepSelectionVisible();
	};
	measure();

	const observer = new ResizeObserver(measure);
	observer.observe(list);
	observer.observe(probe);

	return () => {
		observer.disconnect();
	};
});

const findFiles = $derived(createFileFinder(files ?? []));
const matches = $derived(findFiles(query));
const viewportTop = $derived(
	Math.max(0, Math.min(scrollTop, matches.length * rowHeight - viewportHeight)),
);
const shown = $derived.by(() => {
	if (rowHeight === 0 || matches.length === 0) return { start: 0, end: 0 };

	const start = Math.min(
		matches.length - 1,
		Math.max(0, Math.floor((viewportTop - viewportHeight) / rowHeight)),
	);
	const end = Math.min(
		matches.length,
		Math.max(
			start + 1,
			Math.ceil((viewportTop + 2 * viewportHeight) / rowHeight),
		),
	);

	return { start, end };
});
const visible = $derived(matches.slice(shown.start, shown.end));
const activeOption = $derived(
	selectedIndex >= shown.start && selectedIndex < shown.end
		? optionId(selectedIndex)
		: undefined,
);

function optionId(index: number): string {
	return `${listId}-option-${index}`;
}

function handleInput(e: Event) {
	query = (e.currentTarget as HTMLInputElement).value;
	selectedIndex = 0;
	if (listEl) listEl.scrollTop = 0;
	scrollTop = 0;
}

function cancel(e: Event) {
	e.preventDefault();
	inputEl?.closest("dialog")?.close();
	onclose();
}

function choose(path: string) {
	inputEl?.closest("dialog")?.close();
	onselect(path);
}

function keepSelectionVisible() {
	if (rowHeight === 0 || viewportHeight === 0 || matches.length === 0) return;

	const top = viewportTop / rowHeight;
	const bottom = (viewportTop + viewportHeight) / rowHeight;
	const firstVisible = Math.floor(top);
	const lastVisible = Math.min(matches.length - 1, Math.ceil(bottom) - 1);
	const firstWhole = Math.ceil(top);
	const lastWhole = Math.min(lastVisible, Math.floor(bottom) - 1);
	const hasWholeRow = firstWhole <= lastWhole;

	if (selectedIndex < firstVisible) {
		selectedIndex = hasWholeRow ? firstWhole : firstVisible;
	} else if (selectedIndex > lastVisible) {
		selectedIndex = hasWholeRow ? lastWhole : lastVisible;
	}
}

function syncScroll(top: number) {
	if (scrollTop === top) return;

	scrollTop = top;
	keepSelectionVisible();
}

function handleKeydown(e: KeyboardEvent) {
	if (e.isComposing) return;

	if (e.key === "Escape") {
		e.stopPropagation();
		cancel(e);
		return;
	}

	if (listEl) syncScroll(listEl.scrollTop);

	if (e.key === "Enter") {
		e.preventDefault();
		const chosen = matches[selectedIndex];
		if (chosen) choose(chosen.path);
		return;
	}

	if (!listEl || rowHeight === 0 || matches.length === 0) return;

	const page = Math.max(1, Math.floor(viewportHeight / rowHeight));
	let step: number;
	switch (e.key) {
		case "ArrowDown":
			step = 1;
			break;
		case "ArrowUp":
			step = -1;
			break;
		case "PageDown":
			step = page;
			break;
		case "PageUp":
			step = -page;
			break;
		default:
			return;
	}

	e.preventDefault();
	selectedIndex = Math.max(
		0,
		Math.min(selectedIndex + step, matches.length - 1),
	);

	const top = selectedIndex * rowHeight;
	const bottom = top + rowHeight;
	if (top < listEl.scrollTop) {
		listEl.scrollTop = top;
	} else if (bottom > listEl.scrollTop + viewportHeight) {
		listEl.scrollTop = bottom - viewportHeight;
	}
	scrollTop = listEl.scrollTop;
}

function handleScroll(e: Event & { currentTarget: HTMLDivElement }) {
	syncScroll(e.currentTarget.scrollTop);
}

function rowLabel(file: TrackedFile): string {
	const parts = [file.path];
	if (file.changed) parts.push("changed");

	const count = commentCounts.get(file.path) ?? 0;
	if (count > 0) {
		parts.push(`${count} comment${count === 1 ? "" : "s"}`);
		const breakdown = tallyBreakdown(
			tallyEntries(commentTallies.get(file.path)),
		);
		if (breakdown) parts.push(breakdown);
	}

	return parts.join(", ");
}
</script>

<Dialog variant="palette" title="Comment on a file" oncancel={cancel}>
	<input
		bind:this={inputEl}
		type="text"
		role="combobox"
		aria-expanded={matches.length > 0}
		aria-controls={listId}
		aria-autocomplete="list"
		aria-activedescendant={activeOption}
		aria-describedby={matches.length === 0 ? statusId : undefined}
		aria-label="Find a tracked file to comment on"
		placeholder="Comment on a file…"
		value={query}
		oninput={handleInput}
		onkeydown={handleKeydown}
		class={paletteInputClass}
	>

	<div
		bind:this={rowProbe}
		class="finder-row-probe absolute invisible"
		aria-hidden="true"
	></div>
	<div
		bind:this={listEl}
		id={listId}
		role="listbox"
		aria-label="Tracked files"
		hidden={matches.length === 0}
		tabindex={-1}
		onscroll={handleScroll}
		class="finder-list flex-auto min-h-0 my-1 overflow-y-auto text-callout leading-normal"
	>
		<div aria-hidden="true" style:height={`${shown.start * rowHeight}px`}></div>
		{#each visible as file, offset (file.path)}
			{@const index = shown.start + offset}
			<ListOption
				id={optionId(index)}
				data-path={file.path}
				tabindex={-1}
				selected={index === selectedIndex}
				aria-label={rowLabel(file)}
				aria-posinset={index + 1}
				aria-setsize={matches.length}
				onclick={() => choose(file.path)}
			>
				{#if file.changed}
					<span
						aria-hidden="true"
						class="dot-slot dot rounded-full shrink-0 bg-accent"
					></span>
				{:else}
					<span aria-hidden="true" class="dot-slot shrink-0"></span>
				{/if}
				<FilePathLabel path={file.path} match={file.match} />
				{#if (commentCounts.get(file.path) ?? 0) > 0}
					<span class="ml-auto shrink-0">
						<CommentBadge
							count={commentCounts.get(file.path) ?? 0}
							tally={commentTallies.get(file.path)}
						/>
					</span>
				{/if}
			</ListOption>
		{/each}
		<div
			aria-hidden="true"
			style:height={`${(matches.length - shown.end) * rowHeight}px`}
		></div>
	</div>
	{#if matches.length === 0}
		<div
			id={statusId}
			role="status"
			class="p-3 text-callout leading-normal text-text-muted"
		>
			{files === null ? "Loading tracked files…" : "No tracked file matches"}
		</div>
	{/if}
</Dialog>

<style>
.finder-row-probe,
.finder-list {
	--finder-row-height: calc(
		var(--text-callout) *
		var(--leading-normal) +
		4 *
		var(--u)
	);
}

.finder-row-probe,
.finder-list :global([role="option"]) {
	height: var(--finder-row-height);
}

.finder-list {
	overflow-anchor: none;
}

.dot-slot {
	width: calc(3 * var(--u) / 2);
}

.dot {
	height: calc(3 * var(--u) / 2);
}
</style>
