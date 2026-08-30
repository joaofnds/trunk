<script lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { tick } from "svelte";
import { safeInvoke } from "../lib/invoke.js";
import { displayPath } from "../lib/path.js";
import { filterRecents } from "../lib/recent-filter.js";
import {
	clampHighlightedIdx,
	nextHighlightedIdx,
	pickerKeyAction,
} from "../lib/recent-picker-keys.js";
import {
	getRecentRepos,
	type RecentRepo,
	removeRecentRepo,
} from "../lib/store.js";

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
let listEl: HTMLUListElement | undefined = $state();

const filtered = $derived(filterRecents(recents, query));

// Prune + load each time the picker transitions to visible.
$effect(() => {
	if (!visible) return;
	(async () => {
		loading = true;
		query = "";
		highlightedIdx = 0;

		const all = await getRecentRepos();
		const validations = await Promise.all(
			all.map((r) =>
				safeInvoke<boolean>("validate_recent_path", { path: r.path }).catch(
					() => false,
				),
			),
		);
		const kept: RecentRepo[] = [];
		const dropped: RecentRepo[] = [];
		all.forEach((repo, i) => {
			if (validations[i]) kept.push(repo);
			else dropped.push(repo);
		});
		if (dropped.length > 0) {
			await Promise.all(dropped.map((r) => removeRecentRepo(r.path)));
		}
		recents = kept;
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
	const li = listEl?.children[highlightedIdx];
	if (li instanceof HTMLElement) {
		li.scrollIntoView({ block: "nearest" });
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
	const name = selected.split("/").at(-1) || selected;
	onpick(selected, name);
}

function handleBackdropClick() {
	onclose();
}
</script>

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 flex justify-center"
    style="background: var(--color-backdrop); z-index: 50;"
    onclick={handleBackdropClick}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex flex-col rounded overflow-hidden"
      style="width: 480px; max-width: 90vw; height: fit-content; margin-top: var(--dialog-drop); background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text);"
      onclick={(e) => e.stopPropagation()}
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={handleKeydown}
        placeholder="Search recent repositories"
        class="w-full px-3 py-2 text-sm outline-none"
        style="background: transparent; color: var(--color-text); border-bottom: 1px solid var(--color-border);"
      />

      {#if loading}
        <!-- intentionally empty body while pruning -->
      {:else if recents.length === 0}
        <div class="flex flex-col items-center gap-3 px-4 py-6">
          <p class="text-sm" style="color: var(--color-text-muted);">No recent repositories</p>
          <button
            onclick={handleOpenDialog}
            class="rounded px-4 py-2 text-sm font-medium cursor-pointer"
            style="background: var(--color-accent); color: var(--color-on-accent);"
          >
            Open Repository
          </button>
        </div>
      {:else if filtered.length === 0}
        <div class="px-4 py-6 text-sm text-center" style="color: var(--color-text-muted);">
          No matches
        </div>
      {:else}
        <ul bind:this={listEl} class="flex flex-col py-1 max-h-96 overflow-y-auto">
          {#each filtered as repo, idx (repo.path)}
            {@const dp = resolvedPaths[repo.path] ?? repo.path}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="px-3 py-2 cursor-pointer flex flex-col gap-0.5"
              style="background: {idx === highlightedIdx
                ? 'var(--color-hover)'
                : 'transparent'};"
              onmousemove={() => (highlightedIdx = idx)}
              onclick={() => onpick(repo.path, repo.name)}
            >
              <span class="text-sm font-semibold truncate" style="color: var(--color-text);">{repo.name}</span>
              <span class="text-xs truncate" style="color: var(--color-text-muted);">{dp}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}
