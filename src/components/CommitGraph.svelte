<script lang="ts">
  import SvelteVirtualList from '@humanspeak/svelte-virtual-list';
  import { tick, untrack } from 'svelte';
  import { safeInvoke, type TrunkError } from '../lib/invoke.js';
  import type { GraphCommit } from '../lib/types.js';
  import CommitRow from './CommitRow.svelte';

  interface Props {
    repoPath: string;
    oncommitselect?: (oid: string) => void;
  }

  let { repoPath, oncommitselect }: Props = $props();

  const BATCH = 200;
  const SKELETON_COUNT = 10;

  let commits = $state<GraphCommit[]>([]);
  let hasMore = $state(true);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let offset = $state(0);
  let listRef = $state<{ scroll: (opts: { index: number; smoothScroll?: boolean; align?: string }) => Promise<void> } | null>(null);
  let scrolledToHead = false;

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    error = null;
    try {
      const batch = await safeInvoke<GraphCommit[]>('get_commit_graph', {
        path: repoPath,
        offset,
      });
      commits.push(...batch);
      offset += batch.length;
      if (batch.length < BATCH) hasMore = false;
    } catch (e) {
      const err = e as TrunkError;
      error = err.message ?? 'Failed to load commits';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    untrack(() => loadMore());
  });

  $effect(() => {
    // Only scroll once per mount (scrolledToHead guards against re-firing)
    if (scrolledToHead) return;
    if (!listRef) return;
    if (commits.length === 0) return;

    const headIdx = commits.findIndex(c => c.is_head);
    if (headIdx >= 0) {
      scrolledToHead = true;
      tick().then(() => listRef?.scroll({ index: headIdx, smoothScroll: false, align: 'top' }));
    } else if (untrack(() => hasMore)) {
      // HEAD not in current batch — load the next batch so the effect re-fires with more commits.
      // untrack prevents hasMore from creating a reactive dependency here.
      untrack(() => loadMore());
    }
  });
</script>

<div class="h-full overflow-hidden" style="background: var(--color-bg);">
  {#if commits.length === 0 && loading}
    <!-- Initial skeleton loading -->
    {#each { length: SKELETON_COUNT } as _}
      <div class="flex items-center gap-2 px-2 animate-pulse" style="height: 26px">
        <div
          class="rounded-full flex-shrink-0"
          style="background: var(--color-border); width: 64px; height: 12px;"
        ></div>
        <div
          class="rounded flex-shrink-0"
          style="background: var(--color-border); width: 32px; height: 100%;"
        ></div>
        <div class="rounded flex-1" style="background: var(--color-border); height: 12px;"></div>
      </div>
    {/each}
  {:else if commits.length === 0 && error}
    <!-- Initial load error -->
    <div
      class="m-4 rounded-md px-4 py-3 text-sm"
      style="background: #3d1c1c; border: 1px solid #6b2a2a; color: #f87171;"
    >
      {error}
    </div>
  {:else}
    <SvelteVirtualList
      bind:this={listRef}
      items={commits}
      defaultEstimatedItemHeight={26}
      onLoadMore={loadMore}
      loadMoreThreshold={50}
      {hasMore}
    >
      {#snippet renderItem(commit)}
        <CommitRow {commit} onselect={oncommitselect} />
      {/snippet}
    </SvelteVirtualList>

    <!-- Mid-scroll skeleton (more commits loading) -->
    {#if loading && commits.length > 0}
      {#each { length: 3 } as _}
        <div class="flex items-center gap-2 px-2 animate-pulse" style="height: 26px">
          <div
            class="rounded-full flex-shrink-0"
            style="background: var(--color-border); width: 64px; height: 12px;"
          ></div>
          <div
            class="rounded flex-shrink-0"
            style="background: var(--color-border); width: 32px; height: 100%;"
          ></div>
          <div
            class="rounded flex-1"
            style="background: var(--color-border); height: 12px;"
          ></div>
        </div>
      {/each}
    {/if}

    <!-- Mid-scroll error + retry -->
    {#if error && commits.length > 0}
      <div class="flex items-center gap-3 px-4 py-2">
        <span class="text-sm" style="color: #f87171;">{error}</span>
        <button
          onclick={loadMore}
          class="rounded px-3 py-1 text-xs font-medium"
          style="background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text);"
        >
          Retry
        </button>
      </div>
    {/if}
  {/if}
</div>
