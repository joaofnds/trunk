<script lang="ts">
// The changed-first fuzzy file finder (D11, plan §3). It is how a user reaches a
// file no pending change touches, which is the entry point Trunk has never had.
//
// The source list is the backend's tracked-file enumeration, so untracked and
// ignored files cannot appear here at all. The finder never reads the filesystem
// itself; picking a row reports the path and the host opens it.

import { rankFiles } from "../lib/file-finder.js";
import { tallyEntries } from "../lib/review-filter.js";
import type { ReviewTally, TrackedFile } from "../lib/types.js";
import ListOption from "../lib/ui/ListOption.svelte";

interface Props {
	files: TrackedFile[];
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

let query = $state("");
let selectedIndex = $state(0);
let dialogEl: HTMLDialogElement | undefined = $state();

$effect(() => {
	if (dialogEl && !dialogEl.open) dialogEl.showModal();
});

const matches = $derived(rankFiles(files, query));

function handleInput(e: Event) {
	query = (e.currentTarget as HTMLInputElement).value;
	// A narrowed list makes the old index meaningless, and the top row is the
	// one the new query ranked best.
	selectedIndex = 0;
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		onclose();
	} else if (e.key === "ArrowDown") {
		e.preventDefault();
		selectedIndex = Math.min(selectedIndex + 1, matches.length - 1);
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		selectedIndex = Math.max(selectedIndex - 1, 0);
	} else if (e.key === "Enter") {
		e.preventDefault();
		const chosen = matches[selectedIndex];
		if (chosen) onselect(chosen.path);
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}

function rowLabel(file: TrackedFile): string {
	const parts = [file.path];
	if (file.changed) parts.push("changed");

	const count = commentCounts.get(file.path) ?? 0;
	if (count > 0) parts.push(`${count} comment${count === 1 ? "" : "s"}`);

	return parts.join(", ");
}
</script>

<!-- The dialog element fills the viewport as a transparent layer so the
     palette can sit a little above centre, where the eye already is. The
     spacer takes that share of the free height so the box needs no offset of
     its own, which is what keeps this a flex layout rather than a padding
     hack. The UA's fit-content size and margins would centre the box instead. -->
<dialog
	bind:this={dialogEl}
	class="fixed inset-0 flex flex-col items-center backdrop:bg-backdrop w-auto h-auto max-w-none max-h-none m-0 p-0 border-none bg-transparent"
	aria-label="Comment on a file"
	oncancel={onclose}
>
	<div class="flex-1" aria-hidden="true"></div>
	<div
		class="flex flex-col rounded bg-surface-raised border border-border shadow-lg finder-box overflow-hidden relative flex-initial"
	>
		<input
			type="text"
			role="combobox"
			aria-expanded="true"
			aria-controls="file-finder-list"
			aria-label="Find a tracked file to comment on"
			placeholder="Comment on a file…"
			value={query}
			oninput={handleInput}
			onkeydown={handleKeydown}
			use:autofocus
			class="bg-bg border-none border-b border-border text-text p-3 text-body leading-normal outline-none"
		>

		<div
			id="file-finder-list"
			role="listbox"
			aria-label="Tracked files"
			class="flex-1 min-h-0 overflow-y-auto text-callout leading-normal"
		>
			{#each matches as file, i (file.path)}
				<ListOption
					selected={i === selectedIndex}
					aria-label={rowLabel(file)}
					onclick={() => onselect(file.path)}
				>
					{#if file.changed}
						<span
							aria-hidden="true"
							class="dot-slot dot rounded-full shrink-0 bg-accent"
						></span>
					{:else}
						<span aria-hidden="true" class="dot-slot shrink-0"></span>
					{/if}
					<span class="overflow-hidden text-ellipsis whitespace-nowrap">
						{file.path}
					</span>
					{#if (commentCounts.get(file.path) ?? 0) > 0}
						<span
							class="finder-comment-count ml-auto shrink-0 py-0 px-1 rounded text-on-accent text-small"
							role="img"
							aria-label="{commentCounts.get(file.path)} review comments"
							style:background="var(--color-thread-{tallyEntries(commentTallies.get(file.path))[0]?.tone ?? 'open'})"
							>{commentCounts.get(file.path)}</span
						>
					{/if}
				</ListOption>
			{/each}

			{#if matches.length === 0}
				<div
					role="presentation"
					class="p-3 text-callout leading-normal text-text-muted"
				>
					No tracked file matches
				</div>
			{/if}
		</div>
	</div>
	<div class="flex-3" aria-hidden="true"></div>
</dialog>

<style>
.finder-box {
	width: calc(130 * var(--u));
	max-height: 60vh;
}

.dot-slot {
	width: calc(3 * var(--u) / 2);
}

.dot {
	height: calc(3 * var(--u) / 2);
}
</style>
