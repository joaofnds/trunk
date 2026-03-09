<script lang="ts">
  import { listen } from '@tauri-apps/api/event';
  import { safeInvoke } from '../lib/invoke.js';
  import type { WorkingTreeStatus } from '../lib/types.js';
  import FileRow from './FileRow.svelte';
  import CommitForm from './CommitForm.svelte';

  interface Props {
    repoPath: string;
    currentBranch?: string;
    onfileselect?: (path: string, kind: 'unstaged' | 'staged') => void;
    onsubjectchange?: (value: string) => void;
  }

  let {
    repoPath,
    currentBranch,
    onfileselect,
    onsubjectchange,
  }: Props = $props();

  let status = $state<WorkingTreeStatus | null>(null);
  let unstaged_expanded = $state(true);
  let staged_expanded = $state(true);
  let loadingFiles = $state<Set<string>>(new Set());
  let loadSeq = 0;

  let totalCount = $derived(
    (status?.unstaged.length ?? 0) +
    (status?.staged.length ?? 0) +
    (status?.conflicted.length ?? 0)
  );

  async function loadStatus() {
    const seq = ++loadSeq;
    const result = await safeInvoke<WorkingTreeStatus>('get_status', { path: repoPath });
    if (seq === loadSeq) {
      status = result;
    }
  }

  async function stageFile(filePath: string) {
    loadingFiles = new Set([...loadingFiles, filePath]);
    await safeInvoke('stage_file', { path: repoPath, filePath });
    await loadStatus();
    const next = new Set(loadingFiles);
    next.delete(filePath);
    loadingFiles = next;
  }

  async function unstageFile(filePath: string) {
    loadingFiles = new Set([...loadingFiles, filePath]);
    await safeInvoke('unstage_file', { path: repoPath, filePath });
    await loadStatus();
    const next = new Set(loadingFiles);
    next.delete(filePath);
    loadingFiles = next;
  }

  async function stageAll() {
    await safeInvoke('stage_all', { path: repoPath });
    await loadStatus();
  }

  async function unstageAll() {
    await safeInvoke('unstage_all', { path: repoPath });
    await loadStatus();
  }

  // Initial load on mount
  $effect(() => {
    if (repoPath) loadStatus();
  });

  // Auto-refresh on repo-changed event
  $effect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('repo-changed', (event) => {
      if (event.payload === repoPath) loadStatus();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  });
</script>

<div style="
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
">
  <!-- Panel header -->
  <div style="
    height: 32px;
    border-bottom: 1px solid var(--color-border);
    padding: 0 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  ">
    <span style="font-size: 12px; color: var(--color-text);">
      {totalCount} file{totalCount === 1 ? '' : 's'} changed
    </span>
    {#if currentBranch}
      <span style="
        background: var(--color-surface);
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 11px;
        color: var(--color-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 120px;
      ">
        {currentBranch}
      </span>
    {/if}
  </div>

  <!-- Scrollable file sections wrapper -->
  <div style="flex: 1; overflow-y: auto; min-height: 0;">
    <!-- Unstaged Files section -->
    <div>
      <div
        role="button"
        tabindex="0"
        onclick={() => (unstaged_expanded = !unstaged_expanded)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') unstaged_expanded = !unstaged_expanded; }}
        style="
          height: 28px;
          border-bottom: 1px solid var(--color-border);
          padding: 0 8px;
          display: flex;
          align-items: center;
          cursor: pointer;
          user-select: none;
        "
      >
        <span style="color: var(--color-text-muted); font-size: 10px; margin-right: 4px;">
          {unstaged_expanded ? '▼' : '▶'}
        </span>
        <span style="color: var(--color-text); font-size: 12px; font-weight: 500; flex: 1;">
          Unstaged Files ({(status?.unstaged.length ?? 0) + (status?.conflicted.length ?? 0)})
        </span>
        {#if (status?.unstaged.length ?? 0) > 0 || (status?.conflicted.length ?? 0) > 0}
          <button
            onclick={(e) => { e.stopPropagation(); stageAll(); }}
            style="
              color: var(--color-text-muted);
              font-size: 11px;
              background: none;
              border: none;
              cursor: pointer;
              padding: 0 4px;
              white-space: nowrap;
            "
            aria-label="Stage all changes"
          >
            Stage All Changes
          </button>
        {/if}
      </div>

      {#if unstaged_expanded}
        <div role="list">
          {#each status?.unstaged ?? [] as f (f.path)}
            <FileRow
              file={f}
              actionLabel="+"
              isLoading={loadingFiles.has(f.path)}
              onaction={() => stageFile(f.path)}
              onclick={() => onfileselect?.(f.path, 'unstaged')}
            />
          {/each}
          {#each status?.conflicted ?? [] as f (f.path)}
            <FileRow
              file={f}
              actionLabel="+"
              isLoading={loadingFiles.has(f.path)}
              onaction={() => stageFile(f.path)}
              onclick={() => onfileselect?.(f.path, 'unstaged')}
            />
          {/each}
        </div>
      {/if}
    </div>

    <!-- Staged Files section -->
    <div>
      <div
        role="button"
        tabindex="0"
        onclick={() => (staged_expanded = !staged_expanded)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') staged_expanded = !staged_expanded; }}
        style="
          height: 28px;
          border-bottom: 1px solid var(--color-border);
          padding: 0 8px;
          display: flex;
          align-items: center;
          cursor: pointer;
          user-select: none;
        "
      >
        <span style="color: var(--color-text-muted); font-size: 10px; margin-right: 4px;">
          {staged_expanded ? '▼' : '▶'}
        </span>
        <span style="color: var(--color-text); font-size: 12px; font-weight: 500; flex: 1;">
          Staged Files ({status?.staged.length ?? 0})
        </span>
        {#if (status?.staged.length ?? 0) > 0}
          <button
            onclick={(e) => { e.stopPropagation(); unstageAll(); }}
            style="
              color: var(--color-text-muted);
              font-size: 11px;
              background: none;
              border: none;
              cursor: pointer;
              padding: 0 4px;
              white-space: nowrap;
            "
            aria-label="Unstage all"
          >
            Unstage All
          </button>
        {/if}
      </div>

      {#if staged_expanded}
        <div role="list">
          {#each status?.staged ?? [] as f (f.path)}
            <FileRow
              file={f}
              actionLabel="−"
              isLoading={loadingFiles.has(f.path)}
              onaction={() => unstageFile(f.path)}
              onclick={() => onfileselect?.(f.path, 'staged')}
            />
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Permanent divider above commit form -->
  <div style="flex-shrink: 0; border-top: 1px solid var(--color-border);"></div>

  <!-- CommitForm — always visible at bottom -->
  <CommitForm {repoPath} stagedCount={status?.staged.length ?? 0} {onsubjectchange} />
</div>
