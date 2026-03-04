<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog';
  import { safeInvoke, type TrunkError } from '../lib/invoke.js';
  import { addRecentRepo, getRecentRepos, removeRecentRepo, type RecentRepo } from '../lib/store.js';

  interface Props {
    onopen: (path: string, name: string) => void;
  }

  let { onopen }: Props = $props();

  let recentRepos = $state<RecentRepo[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    getRecentRepos().then((repos) => {
      recentRepos = repos;
    });
  });

  async function openRepository() {
    error = null;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string') return;

    await openPath(selected);
  }

  async function openPath(path: string) {
    error = null;
    loading = true;
    try {
      await safeInvoke('open_repo', { path });
      const name = path.split('/').at(-1) || path;
      await addRecentRepo({ name, path });
      recentRepos = await getRecentRepos();
      onopen(path, name);
    } catch (e: unknown) {
      const trunk = e as TrunkError;
      error = trunk.message ?? 'Failed to open repository';
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

<div class="flex flex-col items-center justify-center h-screen gap-6" style="background: var(--color-bg);">
  <div class="flex flex-col items-center gap-4 w-full max-w-md px-4">
    <h1 class="text-2xl font-semibold tracking-tight" style="color: var(--color-text);">Trunk</h1>
    <p class="text-sm" style="color: var(--color-text-muted);">Git history, beautifully visualized</p>

    {#if error}
      <div
        class="w-full rounded-md px-4 py-2 text-sm"
        style="background: #3d1c1c; border: 1px solid #6b2a2a; color: #f87171;"
      >
        {error}
      </div>
    {/if}

    <button
      onclick={openRepository}
      disabled={loading}
      class="w-full rounded-md px-4 py-2.5 text-sm font-medium transition-opacity disabled:opacity-50"
      style="background: var(--color-accent); color: #fff;"
    >
      {loading ? 'Opening...' : 'Open Repository'}
    </button>
  </div>

  {#if recentRepos.length > 0}
    <div class="w-full max-w-md px-4">
      <p class="text-xs font-medium mb-2 uppercase tracking-widest" style="color: var(--color-text-muted);">Recent</p>
      <ul class="flex flex-col gap-1">
        {#each recentRepos as repo (repo.path)}
          <li>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="group flex items-center justify-between rounded-md px-3 py-2 cursor-pointer transition-colors"
              style="background: var(--color-surface); border: 1px solid var(--color-border);"
              onclick={() => openPath(repo.path)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && openPath(repo.path)}
            >
              <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                <span class="text-sm font-medium truncate" style="color: var(--color-text);">{repo.name}</span>
                <span class="text-xs truncate" style="color: var(--color-text-muted);">{repo.path}</span>
              </div>
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
