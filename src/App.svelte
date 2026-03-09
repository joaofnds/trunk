<script lang="ts">
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import TabBar from './components/TabBar.svelte';
  import CommitGraph from './components/CommitGraph.svelte';
  import BranchSidebar from './components/BranchSidebar.svelte';
  import StagingPanel from './components/StagingPanel.svelte';
  import DiffPanel from './components/DiffPanel.svelte';
  import CommitDetail from './components/CommitDetail.svelte';
  import { safeInvoke } from './lib/invoke.js';
  import { getZoomLevel, setZoomLevel, getLeftPaneWidth, setLeftPaneWidth, getRightPaneWidth, setRightPaneWidth } from './lib/store.js';
  import type { FileDiff, CommitDetail as CommitDetailType } from './lib/types.js';

  interface DirtyCounts {
    staged: number;
    unstaged: number;
    conflicted: number;
  }
  import { listen } from '@tauri-apps/api/event';

  let zoomLevel = $state(1);
  let leftPaneWidth = $state(220);
  let leftPaneCollapsed = $state(false);
  let rightPaneWidth = $state(240);
  let rightPaneCollapsed = $state(false);
  let repoPath = $state<string | null>(null);
  let repoName = $state<string>('');
  let refreshSignal = $state(0);
  let dirtyCounts = $state<DirtyCounts>({ staged: 0, unstaged: 0, conflicted: 0 });
  let wipSubject = $state('');

  // Staging file selection (from StagingPanel)
  let selectedFile = $state<{ path: string; kind: 'unstaged' | 'staged' } | null>(null);
  let stagingDiffFiles = $state<FileDiff[]>([]);

  // Commit selection (from CommitGraph)
  let selectedCommitOid = $state<string | null>(null);
  let commitDetail = $state<CommitDetailType | null>(null);
  let commitFileDiffs = $state<FileDiff[]>([]);
  let selectedCommitFile = $state<string | null>(null);

  const wipCount = $derived(dirtyCounts.staged + dirtyCounts.unstaged + dirtyCounts.conflicted);

  // Center pane: show DiffPanel when a file is selected (from either source)
  let showDiff = $derived(selectedFile !== null || selectedCommitFile !== null);

  // The diffs to display: filtered commit file diff, or staging diff
  let currentDiffFiles = $derived(
    selectedCommitFile
      ? commitFileDiffs.filter((f) => f.path === selectedCommitFile)
      : stagingDiffFiles
  );

  async function loadDirtyCounts() {
    if (!repoPath) return;
    try {
      const result = await safeInvoke<DirtyCounts>('get_dirty_counts', { path: repoPath });
      dirtyCounts = result;
    } catch {
      // non-fatal — keep previous counts
    }
  }

  function handleOpen(path: string, name: string) {
    repoPath = path;
    repoName = name;
  }

  function handleRefresh() {
    refreshSignal += 1;
  }

  function clearStagingDiff() {
    selectedFile = null;
    stagingDiffFiles = [];
  }

  function clearCommitFileDiff() {
    selectedCommitFile = null;
  }

  function clearCommit() {
    selectedCommitOid = null;
    commitDetail = null;
    commitFileDiffs = [];
    selectedCommitFile = null;
  }

  function handleDiffClose() {
    if (selectedFile) clearStagingDiff();
    else clearCommitFileDiff();
  }

  async function handleFileSelect(path: string, kind: 'unstaged' | 'staged') {
    if (selectedFile?.path === path && selectedFile?.kind === kind) {
      clearStagingDiff();
      return;
    }
    selectedFile = { path, kind };
    if (!repoPath) return;
    try {
      const command = kind === 'unstaged' ? 'diff_unstaged' : 'diff_staged';
      stagingDiffFiles = await safeInvoke<FileDiff[]>(command, { path: repoPath, filePath: path });
    } catch {
      stagingDiffFiles = [];
    }
  }

  async function handleCommitSelect(oid: string) {
    if (selectedCommitOid === oid) {
      clearCommit();
      return;
    }
    // Switching to commit view — close any open staging diff
    clearStagingDiff();
    selectedCommitFile = null;
    selectedCommitOid = oid;
    if (!repoPath) return;
    try {
      const [files, detail] = await Promise.all([
        safeInvoke<FileDiff[]>('diff_commit', { path: repoPath, oid }),
        safeInvoke<CommitDetailType>('get_commit_detail', { path: repoPath, oid }),
      ]);
      commitFileDiffs = files;
      commitDetail = detail;
    } catch {
      commitFileDiffs = [];
      commitDetail = null;
    }
  }

  function handleCommitFileSelect(path: string) {
    if (selectedCommitFile === path) {
      clearCommitFileDiff();
      return;
    }
    selectedCommitFile = path;
  }

  async function refetchFileDiff(path: string, kind: 'unstaged' | 'staged') {
    if (!repoPath) return;
    try {
      const command = kind === 'unstaged' ? 'diff_unstaged' : 'diff_staged';
      stagingDiffFiles = await safeInvoke<FileDiff[]>(command, { path: repoPath, filePath: path });
    } catch {
      stagingDiffFiles = [];
    }
  }

  $effect(() => {
    if (repoPath) {
      loadDirtyCounts();
    }
  });

  $effect(() => {
    let unlisten: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    listen<string>('repo-changed', (event) => {
      if (event.payload === repoPath) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          handleRefresh();
          loadDirtyCounts();
          if (selectedFile) {
            refetchFileDiff(selectedFile.path, selectedFile.kind);
          }
        }, 200);
      }
    }).then((fn) => { unlisten = fn; });

    return () => {
      unlisten?.();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  $effect(() => {
    getZoomLevel().then((level) => { zoomLevel = level; });
  });

  $effect(() => {
    getLeftPaneWidth().then((w) => { leftPaneWidth = w; });
    getRightPaneWidth().then((w) => { rightPaneWidth = w; });
  });

  $effect(() => {
    document.documentElement.style.zoom = String(zoomLevel);
  });

  $effect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomLevel = +(Math.min(3, zoomLevel + 0.1).toFixed(1));
        setZoomLevel(zoomLevel);
      } else if (e.key === '-') {
        e.preventDefault();
        zoomLevel = +(Math.max(0.5, zoomLevel - 0.1).toFixed(1));
        setZoomLevel(zoomLevel);
      } else if (e.key === '0') {
        e.preventDefault();
        zoomLevel = 1;
        setZoomLevel(zoomLevel);
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        leftPaneCollapsed = !leftPaneCollapsed;
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        rightPaneCollapsed = !rightPaneCollapsed;
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  function startLeftResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftPaneCollapsed ? 0 : leftPaneWidth;

    function onMouseMove(ev: MouseEvent) {
      const newWidth = Math.max(0, startWidth + ev.clientX - startX);
      if (newWidth < 50) {
        leftPaneCollapsed = true;
      } else {
        leftPaneCollapsed = false;
        leftPaneWidth = Math.min(600, newWidth);
      }
    }

    function onMouseUp() {
      if (!leftPaneCollapsed) setLeftPaneWidth(leftPaneWidth);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function startRightResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPaneCollapsed ? 0 : rightPaneWidth;

    function onMouseMove(ev: MouseEvent) {
      const newWidth = Math.max(0, startWidth - (ev.clientX - startX));
      if (newWidth < 50) {
        rightPaneCollapsed = true;
      } else {
        rightPaneCollapsed = false;
        rightPaneWidth = Math.min(700, newWidth);
      }
    }

    function onMouseUp() {
      if (!rightPaneCollapsed) setRightPaneWidth(rightPaneWidth);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  async function handleClose() {
    if (repoPath) {
      try {
        await safeInvoke('close_repo', { path: repoPath });
      } catch {
        // State is cleaned up regardless
      }
    }
    repoPath = null;
    repoName = '';
    refreshSignal = 0;
    clearStagingDiff();
    clearCommit();
  }
</script>

<style>
  .pane-divider {
    width: 4px;
    flex-shrink: 0;
    cursor: col-resize;
    user-select: none;
    background: linear-gradient(to right, transparent 1.5px, var(--color-border) 1.5px, var(--color-border) 2.5px, transparent 2.5px);
    transition: background 0.15s;
  }
  .pane-divider:hover {
    background: linear-gradient(to right, transparent 1px, var(--color-accent) 1px, var(--color-accent) 3px, transparent 3px);
  }
</style>

<div class="flex flex-col h-screen" style="background: var(--color-bg);">
  {#if repoPath === null}
    <WelcomeScreen onopen={handleOpen} />
  {:else}
    <TabBar {repoName} onclose={handleClose} />
    <main class="flex-1 overflow-hidden flex">
      <div style="width: {leftPaneCollapsed ? 0 : leftPaneWidth}px; flex-shrink: 0; overflow: hidden; display: flex; flex-direction: column;">
        <BranchSidebar repoPath={repoPath!} onrefreshed={handleRefresh} />
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="pane-divider" style="display: {leftPaneCollapsed ? 'none' : 'block'};" onmousedown={startLeftResize}></div>
      <div class="flex-1 overflow-hidden">
        {#if showDiff}
          <DiffPanel fileDiffs={currentDiffFiles} commitDetail={null} onclose={handleDiffClose} />
        {:else}
          <CommitGraph {repoPath} oncommitselect={handleCommitSelect} {wipCount} wipMessage={wipSubject.trim() || 'WIP'} onWipClick={clearCommit} {refreshSignal} />
        {/if}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="pane-divider" style="display: {rightPaneCollapsed ? 'none' : 'block'};" onmousedown={startRightResize}></div>
      <div style="width: {rightPaneCollapsed ? 0 : rightPaneWidth}px; flex-shrink: 0; overflow: hidden; display: flex; flex-direction: column;">
        {#if selectedCommitOid && commitDetail}
          <CommitDetail
            {commitDetail}
            fileDiffs={commitFileDiffs}
            selectedFile={selectedCommitFile}
            onfileselect={handleCommitFileSelect}
            onclose={clearCommit}
          />
        {:else}
          <StagingPanel repoPath={repoPath!} onfileselect={handleFileSelect} onsubjectchange={(v) => (wipSubject = v)} />
        {/if}
      </div>
    </main>
  {/if}
</div>
