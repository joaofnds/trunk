<script lang="ts">
  import VirtualList from './VirtualList.svelte';
  import { tick, untrack } from 'svelte';
  import { safeInvoke, type TrunkError } from '../lib/invoke.js';
  import { clearRedoStack } from '../lib/undo-redo.svelte.js';
  import type { GraphCommit, GraphResponse, EdgeType, StashEntry } from '../lib/types.js';
  import { getColumnWidths, setColumnWidths, type ColumnWidths, getColumnVisibility, setColumnVisibility, type ColumnVisibility } from '../lib/store.js';
  import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, MERGE_STROKE } from '../lib/graph-constants.js';
  import { buildGraphData } from '../lib/active-lanes.js';
  import { buildOverlayPaths } from '../lib/overlay-paths.js';
  import { getVisibleOverlayElements } from '../lib/overlay-visible.js';

  import { Menu, MenuItem, Submenu, PredefinedMenuItem, CheckMenuItem } from '@tauri-apps/api/menu';
  import { writeText } from '@tauri-apps/plugin-clipboard-manager';
  import { ask, message } from '@tauri-apps/plugin-dialog';
  import CommitRow from './CommitRow.svelte';
  import InputDialog from './InputDialog.svelte';

  interface Props {
    repoPath: string;
    oncommitselect?: (oid: string) => void;
    wipCount?: number;
    wipMessage?: string;
    onWipClick?: () => void;
    refreshSignal?: number;
    selectedCommitOid?: string | null;
  }

  let { repoPath, oncommitselect, wipCount = 0, wipMessage = 'WIP', onWipClick, refreshSignal, selectedCommitOid }: Props = $props();

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

  let stashOidToIndex = $state<Map<string, number>>(new Map());

  async function loadStashMap() {
    try {
      const stashes = await safeInvoke<StashEntry[]>('list_stashes', { path: repoPath });
      const map = new Map<string, number>();
      for (const stash of stashes) {
        map.set(stash.oid, stash.index);
      }
      stashOidToIndex = map;
    } catch {
      stashOidToIndex = new Map();
    }
  }

  function startColumnResize(column: keyof ColumnWidths, e: MouseEvent, invert = false) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = columnWidths[column];
    const minWidths: Record<keyof ColumnWidths, number> = {
      ref: 60,
      graph: Math.max(maxColumns, 1) * LANE_WIDTH,
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

  // InputDialog state
  interface DialogConfig {
    title: string;
    fields: { key: string; label: string; placeholder?: string; multiline?: boolean; required?: boolean }[];
    onsubmit: (values: Record<string, string>) => void;
  }
  let dialogConfig = $state<DialogConfig | null>(null);

  function closeDialog() {
    dialogConfig = null;
  }

  // Commit context menu actions

  async function handleCheckoutCommit(commit: GraphCommit) {
    const confirmed = await ask(
      "Checkout this commit in detached HEAD mode? You won't be on any branch. Create a branch afterward to save your work.",
      { title: 'Checkout Commit', kind: 'warning' }
    );
    if (!confirmed) return;
    try {
      await safeInvoke('checkout_commit', { path: repoPath, oid: commit.oid });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Failed to checkout commit', { title: 'Checkout Error', kind: 'error' });
    }
  }

  function handleCreateBranch(commit: GraphCommit) {
    dialogConfig = {
      title: 'Create Branch',
      fields: [{ key: 'name', label: 'Branch name', required: true }],
      onsubmit: async (values) => {
        closeDialog();
        try {
          await safeInvoke('create_branch', { path: repoPath, name: values.name, fromOid: commit.oid });
        } catch (e) {
          const err = e as TrunkError;
          await message(err.message ?? 'Failed to create branch', { title: 'Create Branch Error', kind: 'error' });
        }
      },
    };
  }

  function handleCreateTag(commit: GraphCommit) {
    dialogConfig = {
      title: 'Create Tag',
      fields: [
        { key: 'name', label: 'Tag name', required: true },
        { key: 'message', label: 'Message (optional)', multiline: true },
      ],
      onsubmit: async (values) => {
        closeDialog();
        try {
          await safeInvoke('create_tag', { path: repoPath, oid: commit.oid, tagName: values.name, message: values.message || '' });
        } catch (e) {
          const err = e as TrunkError;
          await message(err.message ?? 'Failed to create tag', { title: 'Create Tag Error', kind: 'error' });
        }
      },
    };
  }

  async function handleCherryPick(commit: GraphCommit) {
    clearRedoStack();
    try {
      await safeInvoke('cherry_pick', { path: repoPath, oid: commit.oid });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Cherry-pick failed. You may need to resolve conflicts manually.', { title: 'Cherry-pick Error', kind: 'error' });
    }
  }

  async function handleRevert(commit: GraphCommit) {
    clearRedoStack();
    try {
      await safeInvoke('revert_commit', { path: repoPath, oid: commit.oid });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Revert failed. You may need to resolve conflicts manually.', { title: 'Revert Error', kind: 'error' });
    }
  }

  async function handleReset(commit: GraphCommit, mode: 'soft' | 'mixed' | 'hard') {
    const labels: Record<string, string> = {
      soft: 'Soft reset keeps all changes staged.',
      mixed: 'Mixed reset keeps changes but unstages them.',
      hard: 'Hard reset discards ALL changes. This cannot be undone!',
    };
    const confirmed = await ask(
      `Reset current branch to this commit?\n\n${labels[mode]}`,
      { title: `Reset (${mode})`, kind: mode === 'hard' ? 'warning' : 'info' }
    );
    if (!confirmed) return;
    try {
      await safeInvoke('reset_to_commit', { path: repoPath, oid: commit.oid, mode });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Reset failed.', { title: 'Reset Error', kind: 'error' });
    }
  }

  async function showCommitContextMenu(e: MouseEvent, commit: GraphCommit) {
    e.preventDefault();
    const menu = await Menu.new({
      items: [
        await MenuItem.new({ text: 'Copy SHA', action: () => { writeText(commit.oid).catch(() => {}); } }),
        await MenuItem.new({ text: 'Copy Message', action: () => { writeText(commit.summary).catch(() => {}); } }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({ text: 'Checkout Commit...', action: () => { handleCheckoutCommit(commit).catch(() => {}); } }),
        await MenuItem.new({ text: 'Create Branch...', action: () => { handleCreateBranch(commit); } }),
        await MenuItem.new({ text: 'Create Tag...', action: () => { handleCreateTag(commit); } }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({ text: 'Cherry-pick', enabled: !commit.is_merge, action: () => { handleCherryPick(commit).catch(() => {}); } }),
        await MenuItem.new({ text: 'Revert', enabled: !commit.is_merge, action: () => { handleRevert(commit).catch(() => {}); } }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await Submenu.new({ text: 'Reset...', items: [
          await MenuItem.new({ text: 'Soft', action: () => { handleReset(commit, 'soft').catch(() => {}); } }),
          await MenuItem.new({ text: 'Mixed', action: () => { handleReset(commit, 'mixed').catch(() => {}); } }),
          await MenuItem.new({ text: 'Hard', action: () => { handleReset(commit, 'hard').catch(() => {}); } }),
        ]}),
      ]
    });
    await menu.popup();
  }

  // Stash context menu actions

  async function handleStashPop(index: number) {
    try {
      await safeInvoke('stash_pop', { path: repoPath, index });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Failed to pop stash', { title: 'Stash Error', kind: 'error' });
    }
  }

  async function handleStashApply(index: number) {
    try {
      await safeInvoke('stash_apply', { path: repoPath, index });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Failed to apply stash', { title: 'Stash Error', kind: 'error' });
    }
  }

  async function handleStashDrop(index: number) {
    const confirmed = await ask(`Drop stash@{${index}}? This cannot be undone.`, {
      title: 'Confirm Drop',
      kind: 'warning',
    });
    if (!confirmed) return;
    try {
      await safeInvoke('stash_drop', { path: repoPath, index });
    } catch (e) {
      const err = e as TrunkError;
      await message(err.message ?? 'Failed to drop stash', { title: 'Stash Error', kind: 'error' });
    }
  }

  async function showStashContextMenu(e: MouseEvent, commit: GraphCommit) {
    e.preventDefault();
    const stashIndex = stashOidToIndex.get(commit.oid);
    if (stashIndex === undefined) return;
    const menu = await Menu.new({
      items: [
        await MenuItem.new({ text: 'Pop', action: () => { handleStashPop(stashIndex).catch(() => {}); } }),
        await MenuItem.new({ text: 'Apply', action: () => { handleStashApply(stashIndex).catch(() => {}); } }),
        await MenuItem.new({ text: 'Drop', action: () => { handleStashDrop(stashIndex).catch(() => {}); } }),
      ]
    });
    await menu.popup();
  }

  function handleRowContextMenu(e: MouseEvent, commit: GraphCommit) {
    if (commit.is_stash) {
      showStashContextMenu(e, commit);
    } else {
      showCommitContextMenu(e, commit);
    }
  }

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

  function makeWipItem(msg: string, col: number, colorIdx: number): GraphCommit {
    return {
      oid: '__wip__',
      short_oid: '',
      summary: msg,
      body: null,
      author_name: '',
      author_email: '',
      author_timestamp: 0,
      parent_oids: [],
      column: col,
      color_index: colorIdx,
      edges: [{ from_column: col, to_column: col, edge_type: 'Straight' as EdgeType, color_index: colorIdx, dashed: false }],
      refs: [],
      is_head: false,
      is_merge: false,
      is_branch_tip: false,
      is_stash: false,
    };
  }

  const displayItems = $derived.by(() => {
    // Stash commits are now included in the backend graph result with proper lane data.
    // We only need to prepend the WIP row if there are uncommitted changes.
    if (wipCount > 0) {
      // Find the actual HEAD commit (the one with is_head flag) to match WIP's column and color.
      const headCommit = commits.find(c => c.is_head);
      const col = headCommit?.column ?? 0;
      const colorIdx = headCommit?.color_index ?? 0;
      return [makeWipItem(wipMessage, col, colorIdx), ...commits];
    }
    return [...commits];
  });

  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
  const cx = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
  const cy = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

  const graphData = $derived.by(() => buildGraphData(displayItems, maxColumns));
  const paths = $derived.by(() => buildOverlayPaths(graphData));

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
      await loadStashMap();
    } catch (e) {
      const err = e as TrunkError;
      error = err.message ?? 'Failed to load commits';
      // Keep old commits visible on error -- do NOT clear
    }
  }

  $effect(() => {
    untrack(async () => {
      await loadMore();
      await loadStashMap();
    });
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
        <div class="flex items-center gap-2 px-2 animate-pulse" style="height: {ROW_HEIGHT}px">
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
      <!-- SVG overlay snippet - renders inside virtual list scroll container -->
      {#snippet graphOverlay(contentHeight: number, visibleStart: number, visibleEnd: number)}
        {@const visible = getVisibleOverlayElements(paths, graphData.nodes, visibleStart, visibleEnd)}
        <svg
          class="absolute top-0"
          width={Math.max(maxColumns, 1) * LANE_WIDTH}
          height={contentHeight}
          style="left: {columnWidths.ref}px; pointer-events: none; z-index: 1;"
        >
          <g class="overlay-rails">
            {#each visible.rails as path}
              <path d={path.d} fill="none"
                stroke={laneColor(path.colorIndex)}
                stroke-width={EDGE_STROKE}
                stroke-linecap="butt"
                stroke-dasharray={path.dashed ? '3 3' : 'none'} />
            {/each}
          </g>
          <g class="overlay-connections">
            {#each visible.connections as path}
              <path d={path.d} fill="none"
                stroke={laneColor(path.colorIndex)}
                stroke-width={EDGE_STROKE}
                stroke-linecap="round"
                stroke-dasharray={path.dashed ? '3 3' : 'none'} />
            {/each}
          </g>
          <g class="overlay-dots">
            {#each visible.dots as node}
              {#if node.isWip}
                <circle cx={cx(node.x)} cy={cy(node.y)} r={DOT_RADIUS}
                  fill="none" stroke={laneColor(node.colorIndex)}
                  stroke-width={EDGE_STROKE} stroke-dasharray="3 3" />
              {:else if node.isStash}
                <rect
                  x={cx(node.x) - DOT_RADIUS}
                  y={cy(node.y) - DOT_RADIUS}
                  width={DOT_RADIUS * 2}
                  height={DOT_RADIUS * 2}
                  fill="none"
                  stroke={laneColor(node.colorIndex)}
                  stroke-width={EDGE_STROKE}
                  stroke-dasharray="3 3" />
              {:else if node.isMerge}
                <circle cx={cx(node.x)} cy={cy(node.y)} r={DOT_RADIUS}
                  fill="var(--color-bg)" stroke={laneColor(node.colorIndex)}
                  stroke-width={MERGE_STROKE} />
              {:else}
                <circle cx={cx(node.x)} cy={cy(node.y)} r={DOT_RADIUS}
                  fill={laneColor(node.colorIndex)} />
              {/if}
            {/each}
          </g>
        </svg>
      {/snippet}

      <VirtualList
        bind:this={listRef}
        items={displayItems}
        defaultEstimatedItemHeight={ROW_HEIGHT}
        onLoadMore={loadMore}
        loadMoreThreshold={50}
        {hasMore}
        overlaySnippet={graphOverlay}
      >
        {#snippet renderItem(commit, index)}
          <CommitRow {commit} rowIndex={index} onselect={commit.oid === '__wip__' ? () => onWipClick?.() : oncommitselect} oncontextmenu={handleRowContextMenu} {maxColumns} {columnWidths} {columnVisibility} selected={commit.oid === selectedCommitOid && commit.oid !== '__wip__'} />
        {/snippet}
      </VirtualList>

      <!-- Mid-scroll skeleton (more commits loading) -->
      {#if loading && commits.length > 0}
        {#each { length: 3 } as _}
          <div class="flex items-center gap-2 px-2 animate-pulse" style="height: {ROW_HEIGHT}px">
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

{#if dialogConfig}
  <InputDialog
    title={dialogConfig.title}
    fields={dialogConfig.fields}
    onsubmit={dialogConfig.onsubmit}
    oncancel={closeDialog}
  />
{/if}

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
