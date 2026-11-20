<script lang="ts">
import { tick } from "svelte";
import { open } from "../lib/dialog.js";
import { displayPath } from "../lib/path.js";
import { filterRecents } from "../lib/recent-filter.js";
import {
	clampHighlightedIdx,
	nextHighlightedIdx,
	pickerKeyAction,
} from "../lib/recent-picker-keys.js";
import { repositoryToOpen } from "../lib/repository-to-open.js";
import { getRecentRepos, type RecentRepo } from "../lib/store.js";
import Button from "../lib/ui/Button.svelte";
import ListOption from "../lib/ui/ListOption.svelte";

interface Props {
	open: boolean;
	onpick: (path: string, name: string) => void;
	onclose: () => void;
}

let { open: visible, onpick, onclose }: Props = $props();

let query = $state("");
let recents = $state<RecentRepo[]>([]);
let resolvedPaths = $state<Record<string, string>>({});
let highlightedIdx = $state(0);
let loading = $state(false);
let inputEl: HTMLInputElement | undefined = $state();
let listEl: HTMLDivElement | undefined = $state();
let dialogEl: HTMLDialogElement | undefined = $state();

const filtered = $derived(filterRecents(recents, query));

$effect(() => {
	if (!visible) return;
	(async () => {
		loading = true;
		query = "";
		highlightedIdx = 0;

		recents = await getRecentRepos();
		loading = false;
		await tick();
		inputEl?.focus();
	})();
});

// Lazily tildify paths for display.
$effect(() => {
	for (const repo of recents) {
		if (!(repo.path in resolvedPaths)) {
			displayPath(repo.path).then((p) => {
				resolvedPaths[repo.path] = p;
			});
		}
	}
});

// Keep highlight in bounds as the filter shrinks.
$effect(() => {
	highlightedIdx = clampHighlightedIdx(highlightedIdx, filtered.length);
});

function scrollHighlightedIntoView() {
	const row = listEl?.children[highlightedIdx];
	if (row instanceof HTMLElement) {
		row.scrollIntoView({ block: "nearest" });
	}
}

function handleKeydown(e: KeyboardEvent) {
	const { action, preventDefault } = pickerKeyAction({
		key: e.key,
		queryEmpty: query.length === 0,
	});
	if (preventDefault) e.preventDefault();

	switch (action.kind) {
		case "highlight-down":
			highlightedIdx = nextHighlightedIdx(
				"down",
				highlightedIdx,
				filtered.length,
			);
			scrollHighlightedIntoView();
			return;
		case "highlight-up":
			highlightedIdx = nextHighlightedIdx(
				"up",
				highlightedIdx,
				filtered.length,
			);
			scrollHighlightedIntoView();
			return;
		case "pick": {
			const target = filtered[highlightedIdx];
			if (target) onpick(target.path, target.name);
			return;
		}
		case "close":
			onclose();
			return;
		case "ignore":
			return;
	}
}

async function handleOpenDialog() {
	const selected = await open({ directory: true, multiple: false });
	if (typeof selected !== "string") return;

	const repository = await repositoryToOpen(selected);
	if (repository === null) return;

	onpick(repository, repository.split("/").at(-1) || repository);
}

$effect(() => {
	if (dialogEl && !dialogEl.open) dialogEl.showModal();
});
</script>

{#if visible}
	<!-- Palette-shaped: no title, no padding, pinned near the top. The
	     fixed/inset/mx-auto trio re-states the modal centering that the
	     preflight margin reset wipes, then the top margin drops it. -->
	<dialog
		bind:this={dialogEl}
		class="fixed inset-x-0 top-0 mx-auto flex flex-col rounded overflow-hidden backdrop:bg-backdrop w-dialog-max picker h-fit p-0 bg-surface border border-border text-text"
		aria-label="Open a recent repository"
		oncancel={onclose}
	>
		<input
			bind:this={inputEl}
			bind:value={query}
			onkeydown={handleKeydown}
			aria-label="Search recent repositories"
			placeholder="Search recent repositories"
			class="w-full px-3 py-2 text-body outline-none bg-transparent text-text border-b border-border"
		>

		{#if loading}
			<!-- intentionally empty body while pruning -->
		{:else if recents.length === 0}
			<div class="flex flex-col items-center gap-3 px-4 py-6">
				<p class="text-body text-text-muted">No recent repositories</p>
				<Button variant="primary" size="lg" onclick={handleOpenDialog}>
					Open Repository
				</Button>
			</div>
		{:else if filtered.length === 0}
			<div class="px-4 py-6 text-body text-center text-text-muted">
				No matches
			</div>
		{:else}
			<div
				bind:this={listEl}
				role="listbox"
				aria-label="Recent repositories"
				class="flex flex-col py-1 max-h-dropdown-max overflow-y-auto"
			>
				{#each filtered as repo, idx (repo.path)}
					{@const dp = resolvedPaths[repo.path] ?? repo.path}
					<ListOption
						layout="stack"
						highlight="hover"
						selected={idx === highlightedIdx}
						onmousemove={() => (highlightedIdx = idx)}
						onclick={() => onpick(repo.path, repo.name)}
					>
						<span class="text-body font-semibold truncate text-text"
							>{repo.name}</span
						>
						<span class="text-callout truncate text-text-muted">{dp}</span>
					</ListOption>
				{/each}
			</div>
		{/if}
	</dialog>
{/if}

<style>
.picker {
	max-width: 90vw;
	margin-top: var(--dialog-drop);
}
</style>
