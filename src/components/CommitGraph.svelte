<script lang="ts">
  import SvelteVirtualList from '@humanspeak/svelte-virtual-list';
  import { tick, untrack } from 'svelte';
  import { safeInvoke, type TrunkError } from '../lib/invoke.js';
  import type { GraphCommit, GraphResponse, EdgeType } from '../lib/types.js';
  import { getColumnWidths, setColumnWidths, type ColumnWidths, getColumnVisibility, setColumnVisibility, type ColumnVisibility } from '../lib/store.js';
  import { Menu, CheckMenuItem } from '@tauri-apps/api/menu';
  import CommitRow from './CommitRow.svelte';

  interface Props {
    repoPath: string;
    oncommitselect?: (oid: string) => void;
    wipCount?: number;
    wipMessage?: string;
    onWipClick?: () => void;
    refreshSignal?: number;
  }

  let { repoPath, oncommitselect, wipCount = 0, wipMessage = 'WIP', onWipClick, refreshSignal }: Props = $props();

  const BATCH = 200;
  const SKELETON_COUNT = 10;

  let commits = $state<GraphCommit[]>([]);
  let maxColumns = $state(1);
  let hasMore = $state(true);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let offset = $state(0);
  let listRef = $state<{ scroll: (opts: { index: number; smoothScroll?: boolean; align?: string }) => Promise<void> } | null>(null);
  let scrolledToHead = false;

  let columnWidths = $state<ColumnWidths>({ ref: 120, graph: 120, author: 120, date: 100, sha: 80 });
  let columnVisibility = $state<ColumnVisibility>({ ref: true, graph: true, message: true, author: true, date: true, sha: true });

  $effect(() => {
    getColumnWidths().then((w) => { columnWidths = w; });
  });

  $effect(() => {
    getColumnVisibility().then((v) => { columnVisibility = v; });
  });

  function startColumnResize(column: keyof ColumnWidths, e: MouseEvent, invert = false) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = columnWidths[column];
    const minWidths: Record<keyof ColumnWidths, number> = {
      ref: 60,
      graph: Math.max(maxColumns, 1) * 12,
      author: 60,
      date: 60,
      sha: 50,
    };

    function onMouseMove(ev: MouseEvent) {
      const delta = (ev.clientX - startX) * (invert ? -1 : 1);
      const newWidth = Math.max(minWidths[column], Math.min(400, startWidth + delta));
      columnWidths = { ...columnWidths, [column]: newWidth };
    }

    function onMouseUp() {
      setColumnWidths(columnWidths);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  const columnLabels: { key: keyof ColumnVisibility; label: string }[] = [
    { key: 'ref', label: 'Branch/Tag' },
    { key: 'graph', label: 'Graph' },
    { key: 'message', label: 'Message' },
    { key: 'author', label: 'Author' },
    { key: 'date', label: 'Date' },
    { key: 'sha', label: 'SHA' },
  ];

  async function showHeaderContextMenu(e: MouseEvent) {
    e.preventDefault();
    const items = await Promise.all(
      columnLabels.map((col) =>
        CheckMenuItem.new({
          text: col.label,
          checked: columnVisibility[col.key],
          enabled: col.key !== 'message',
          action: () => {
            if (col.key === 'message') return;
            columnVisibility = { ...columnVisibility, [col.key]: !columnVisibility[col.key] };
            setColumnVisibility(columnVisibility);
          },
        })
      )
    );
    const menu = await Menu.new({ items });
    await menu.popup();
  }

  function makeWipItem(msg: string): GraphCommit {
    return {
      oid: '__wip__',
      short_oid: '',
      summary: msg,
      body: null,
      author_name: '',
      author_email: '',
      author_timestamp: 0,
      parent_oids: [],
      column: 0,
      color_index: 0,
      edges: [{ from_column: 0, to_column: 0, edge_type: 'Straight' as EdgeType, color_index: 0 }],
      refs: [],
      is_head: false,
      is_merge: false,
      is_branch_tip: false,
    };
  }

  const displayItems = $derived(
    wipCount > 0
      ? [makeWipItem(wipMessage), ...commits]
      : commits
  );

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    error = null;
    try {
      const response = await safeInvoke<GraphResponse>('get_commit_graph', {
        path: repoPath,
        offset,
      });
      commits.push(...response.commits);
      maxColumns = response.max_columns;
      offset += response.commits.length;
      if (response.commits.length < BATCH) hasMore = false;
    } catch (e) {
      const err = e as TrunkError;
      error = err.message ?? 'Failed to load commits';
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    try {
      const response = await safeInvoke<GraphResponse>('refresh_commit_graph', {
        path: repoPath,
      });
      // Swap data atomically -- old data stays visible until this assignment
      commits = response.commits;
      maxColumns = response.max_columns;
      offset = response.commits.length;
      hasMore = response.commits.length >= BATCH;
      error = null;
    } catch (e) {
      const err = e as TrunkError;
      error = err.message ?? 'Failed to load commits';
      // Keep old commits visible on error -- do NOT clear
    }
  }

  $effect(() => {
    untrack(() => loadMore());
  });

  $effect(() => {
    // Access refreshSignal to create reactive dependency
    if (refreshSignal !== undefined && refreshSignal > 0) {
      untrack(() => refresh());
    }
  });

  $effect(() => {
    // Only scroll once per mount (scrolledToHead guards against re-firing)
    if (scrolledToHead) return;
    if (!listRef) return;
    if (displayItems.length === 0) return;

    const headIdx = displayItems.findIndex(c => c.is_head);
    if (headIdx >= 0) {
      scrolledToHead = true;
      tick().then(() => listRef?.scroll({ index: headIdx, smoothScroll: false, align: 'top' }));
    } else if (untrack(() => hasMore)) {
      // HEAD not in current batch -- load the next batch so the effect re-fires with more commits.
      // untrack prevents hasMore from creating a reactive dependency here.
      untrack(() => loadMore());
    }
  });
</script>

<div class="h-full overflow-hidden flex flex-col" style="background: var(--color-bg);">
  <!-- Header row (always visible) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex items-center px-2 flex-shrink-0"
    style="height: 24px; background: var(--color-surface); border-bottom: 1px solid var(--color-border); font-size: 11px; color: var(--color-text-muted); user-select: none;"
    oncontextmenu={showHeaderContextMenu}
  >
    {#if columnVisibility.ref}
      <div class="flex-shrink-0 relative px-2" style="width: {columnWidths.ref}px;">
        Branch/Tag
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-resize-handle" onmousedown={(e) => startColumnResize('ref', e)}></div>
      </div>
    {/if}
    {#if columnVisibility.graph}
      <div class="flex-shrink-0 relative px-2" style="width: {columnWidths.graph}px;">
        Graph
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-resize-handle" onmousedown={(e) => startColumnResize('graph', e)}></div>
      </div>
    {/if}
    {#if columnVisibility.message}
      <div class="flex-1 relative px-2">
        Message
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-resize-handle" onmousedown={(e) => startColumnResize('author', e, true)}></div>
      </div>
    {/if}
    {#if columnVisibility.author}
      <div class="flex-shrink-0 relative px-2" style="width: {columnWidths.author}px;">
        Author
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-resize-handle" onmousedown={(e) => startColumnResize('date', e, true)}></div>
      </div>
    {/if}
    {#if columnVisibility.date}
      <div class="flex-shrink-0 relative px-2" style="width: {columnWidths.date}px;">
        Date
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-resize-handle" onmousedown={(e) => startColumnResize('sha', e, true)}></div>
      </div>
    {/if}
    {#if columnVisibility.sha}
      <div class="flex-shrink-0 px-2" style="width: {columnWidths.sha}px;">
        SHA
      </div>
    {/if}
  </div>

  <!-- Content area (grows to fill remaining space) -->
  <div class="flex-1 overflow-hidden">
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
        items={displayItems}
        defaultEstimatedItemHeight={26}
        onLoadMore={loadMore}
        loadMoreThreshold={50}
        {hasMore}
      >
        {#snippet renderItem(commit)}
          <CommitRow {commit} onselect={commit.oid === '__wip__' ? () => onWipClick?.() : oncommitselect} {maxColumns} {columnWidths} {columnVisibility} />
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
</div>

<style>
  .col-resize-handle {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    user-select: none;
    background: linear-gradient(to right, transparent 1.5px, var(--color-border) 1.5px, var(--color-border) 2.5px, transparent 2.5px);
    transition: background 0.15s;
  }
  .col-resize-handle:hover {
    background: linear-gradient(to right, transparent 1px, var(--color-accent) 1px, var(--color-accent) 3px, transparent 3px);
  }
</style>
