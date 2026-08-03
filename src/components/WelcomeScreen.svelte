<script lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { displayPath } from "../lib/path.js";
import {
	addRecentRepo,
	getRecentRepos,
	type RecentRepo,
	removeRecentRepo,
} from "../lib/store.js";

interface Props {
	onopen: (path: string, name: string) => void;
	isFullscreen?: boolean;
}

let { onopen, isFullscreen = false }: Props = $props();

let recentRepos = $state<RecentRepo[]>([]);
let resolvedPaths: Record<string, string> = $state({});
let loading = $state(false);
let error = $state<string | null>(null);

// Storage is uncapped (the picker shows full history); the dashboard intentionally
// shows only the most recent few to keep the welcome screen compact.
const DASHBOARD_RECENT_LIMIT = 10;
const displayedRepos = $derived(recentRepos.slice(0, DASHBOARD_RECENT_LIMIT));

$effect(() => {
	getRecentRepos().then((repos) => {
		recentRepos = repos;
	});
});

$effect(() => {
	for (const repo of recentRepos) {
		if (!(repo.path in resolvedPaths)) {
			displayPath(repo.path).then((p) => {
				resolvedPaths[repo.path] = p;
			});
		}
	}
});

async function openRepository() {
	error = null;
	const selected = await open({ directory: true, multiple: false });
	if (typeof selected !== "string") return;

	await openPath(selected);
}

async function openPath(path: string) {
	error = null;
	loading = true;
	try {
		await safeInvoke("open_repo", { path });
		const name = path.split("/").at(-1) || path;
		await addRecentRepo({ name, path });
		recentRepos = await getRecentRepos();
		onopen(path, name);
	} catch (e: unknown) {
		error = errorMessage(e, "Failed to open repository");
	} finally {
		loading = false;
	}
}

async function handleRemoveRecent(path: string, event: MouseEvent) {
	event.stopPropagation();
	await removeRecentRepo(path);
	recentRepos = await getRecentRepos();
}
</script>

<div class="flex flex-col h-screen" style="background: var(--color-bg);">
  <!-- LAYOUT-02: drag region for window movement on welcome screen -->
  <div data-tauri-drag-region class="flex-shrink-0" style="height: 36px; padding-left: {isFullscreen ? 0 : 78}px;"></div>
  <div class="flex-1 flex flex-col items-center justify-center gap-6">
  <div class="flex flex-col items-center gap-4 w-full max-w-md px-4">
    <h1 class="text-2xl font-semibold tracking-tight" style="color: var(--color-text);">Trunk</h1>
    <p class="text-sm" style="color: var(--color-text-muted);">Git history, beautifully visualized</p>

    {#if error}
      <div class="error-banner w-full rounded-md px-4 py-2 text-sm">
        {error}
      </div>
    {/if}

    <button
      onclick={openRepository}
      disabled={loading}
      class="w-full rounded-md px-4 py-2.5 text-sm font-medium transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      style="background: var(--color-accent); color: var(--color-on-accent);"
    >
      {loading ? 'Opening...' : 'Open Repository'}
    </button>
  </div>

  {#if displayedRepos.length > 0}
    <div class="w-full max-w-md px-4">
      <p class="text-xs font-medium mb-2 uppercase tracking-widest" style="color: var(--color-text-muted);">Recent</p>
      <ul class="flex flex-col gap-1">
        {#each displayedRepos as repo (repo.path)}
          {@const dp = resolvedPaths[repo.path] ?? repo.path}
          <li>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="group flex items-center gap-2 rounded px-3 py-1.5 cursor-pointer hover:bg-white/5"
              onclick={() => openPath(repo.path)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && openPath(repo.path)}
            >
              <span class="text-sm truncate min-w-0 flex-1">
                <span style="color: var(--color-text-muted);">{dp.substring(0, dp.lastIndexOf('/'))}/</span><span class="font-semibold" style="color: var(--color-text);">{dp.split('/').at(-1)}</span>
              </span>
              <button
                class="ml-2 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                style="color: var(--color-text-muted);"
                onclick={(e) => handleRemoveRecent(repo.path, e)}
                aria-label="Remove from recent"
                title="Remove from recent"
              >
                ×
              </button>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  </div>
</div>

<style>
  .error-banner {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
  }
</style>
