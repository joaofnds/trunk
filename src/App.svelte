<script lang="ts">
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import TabBar from './components/TabBar.svelte';
  import CommitGraph from './components/CommitGraph.svelte';
  import BranchSidebar from './components/BranchSidebar.svelte';
  import StagingPanel from './components/StagingPanel.svelte';
  import DiffPanel from './components/DiffPanel.svelte';
  import CommitDetail from './components/CommitDetail.svelte';
  import { safeInvoke } from './lib/invoke.js';
  import { getZoomLevel, setZoomLevel } from './lib/store.js';
  import type { FileDiff, CommitDetail as CommitDetailType } from './lib/types.js';

  interface DirtyCounts {
    staged: number;
    unstaged: number;
    conflicted: number;
  }
  import { listen } from '@tauri-apps/api/event';

  let zoomLevel = $state(1);
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
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

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

<div class="flex flex-col h-screen" style="background: var(--color-bg);">
  {#if repoPath === null}
    <WelcomeScreen onopen={handleOpen} />
  {:else}
    <TabBar {repoName} onclose={handleClose} />
    <main class="flex-1 overflow-hidden flex">
      <BranchSidebar repoPath={repoPath!} onrefreshed={handleRefresh} />
      <div class="flex-1 overflow-hidden">
        {#if showDiff}
          <DiffPanel fileDiffs={currentDiffFiles} commitDetail={null} onclose={handleDiffClose} />
        {:else}
            <CommitGraph {repoPath} oncommitselect={handleCommitSelect} {wipCount} wipMessage={wipSubject.trim() || 'WIP'} onWipClick={clearCommit} {refreshSignal} />
        {/if}
      </div>
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
    </main>
  {/if}
</div>
