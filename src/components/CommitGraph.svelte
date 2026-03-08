<script lang="ts">
  import SvelteVirtualList from '@humanspeak/svelte-virtual-list';
  import { tick, untrack } from 'svelte';
  import { safeInvoke, type TrunkError } from '../lib/invoke.js';
  import type { GraphCommit } from '../lib/types.js';
  import CommitRow from './CommitRow.svelte';

  interface Props {
    repoPath: string;
    oncommitselect?: (oid: string) => void;
    wipCount?: number;
    wipMessage?: string;
    onWipClick?: () => void;
  }

  let { repoPath, oncommitselect, wipCount = 0, wipMessage = 'WIP', onWipClick }: Props = $props();

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
    {#if wipCount > 0}
      <div
        class="flex items-center h-[26px] px-2 hover:bg-[var(--color-surface)] cursor-pointer text-[13px]"
        style="color: var(--color-text-muted);"
        role="button"
        tabindex="0"
        onclick={onWipClick}
        onkeydown={(e) => e.key === 'Enter' && onWipClick?.()}
      >
        <!-- Ref pills placeholder (same width as CommitRow) -->
        <div style="width: 120px; flex-shrink: 0;"></div>
        <!-- Lane SVG: hollow dot at column 0 with line down to first commit -->
        <svg width="18" height="26" style="overflow: visible; flex-shrink: 0;">
          <line x1="9" y1="13" x2="9" y2="26" stroke="var(--lane-0)" stroke-width="2" />
          <circle cx="9" cy="13" r="4" fill="transparent" stroke="var(--lane-0)" stroke-width="2" />
        </svg>
        <!-- Message -->
        <div class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap ml-2" style="color: var(--color-text-muted);">
          {wipMessage}
        </div>
      </div>
    {/if}
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

<style>
  .wip-row {
    display: flex;
    align-items: center;
    height: 28px;
    cursor: pointer;
    background: color-mix(in srgb, var(--lane-0) 8%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--lane-0) 20%, transparent);
  }
  .wip-row:hover { background: color-mix(in srgb, var(--lane-0) 16%, transparent); }
  .wip-lane { width: 30px; flex-shrink: 0; }
  .wip-info { display: flex; align-items: center; gap: 8px; padding-left: 4px; }
  .wip-label { font-style: italic; font-size: 0.85rem; color: var(--lane-0); }
  .wip-badge { font-size: 0.75rem; background: var(--lane-0); color: #000; border-radius: 9999px; padding: 1px 6px; }
</style>
