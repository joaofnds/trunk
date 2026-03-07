<script lang="ts">
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import TabBar from './components/TabBar.svelte';
  import CommitGraph from './components/CommitGraph.svelte';
  import BranchSidebar from './components/BranchSidebar.svelte';
  import StagingPanel from './components/StagingPanel.svelte';
  import DiffPanel from './components/DiffPanel.svelte';
  import { safeInvoke } from './lib/invoke.js';
  import type { FileDiff, CommitDetail } from './lib/types.js';
  import { listen } from '@tauri-apps/api/event';

  let repoPath = $state<string | null>(null);
  let repoName = $state<string>('');
  let graphKey = $state(0);

  let selectedFile = $state<{ path: string; kind: 'unstaged' | 'staged' } | null>(null);
  let selectedCommitOid = $state<string | null>(null);
  let diffFiles = $state<FileDiff[]>([]);
  let diffCommitDetail = $state<CommitDetail | null>(null);

  function handleOpen(path: string, name: string) {
    repoPath = path;
    repoName = name;
  }

  function handleRefresh() {
    graphKey += 1;
  }

  function clearDiff() {
    selectedFile = null;
    selectedCommitOid = null;
    diffFiles = [];
    diffCommitDetail = null;
  }

  async function handleFileSelect(path: string, kind: 'unstaged' | 'staged') {
    // Toggle: clicking the already-selected file closes the diff
    if (selectedFile?.path === path && selectedFile?.kind === kind) {
      clearDiff();
      return;
    }
    selectedCommitOid = null;
    diffCommitDetail = null;
    selectedFile = { path, kind };
    if (!repoPath) return;
    try {
      const command = kind === 'unstaged' ? 'diff_unstaged' : 'diff_staged';
      diffFiles = await safeInvoke<FileDiff[]>(command, { path: repoPath, filePath: path });
    } catch {
      diffFiles = [];
    }
  }

  async function handleCommitSelect(oid: string) {
    // Toggle: clicking the already-selected commit closes the diff
    if (selectedCommitOid === oid) {
      clearDiff();
      return;
    }
    selectedFile = null;
    selectedCommitOid = oid;
    if (!repoPath) return;
    try {
      const [files, detail] = await Promise.all([
        safeInvoke<FileDiff[]>('diff_commit', { path: repoPath, oid }),
        safeInvoke<CommitDetail>('get_commit_detail', { path: repoPath, oid }),
      ]);
      diffFiles = files;
      diffCommitDetail = detail;
    } catch {
      diffFiles = [];
      diffCommitDetail = null;
    }
  }

  async function refetchFileDiff(path: string, kind: 'unstaged' | 'staged') {
    if (!repoPath) return;
    try {
      const command = kind === 'unstaged' ? 'diff_unstaged' : 'diff_staged';
      diffFiles = await safeInvoke<FileDiff[]>(command, { path: repoPath, filePath: path });
    } catch {
      diffFiles = [];
    }
  }

  $effect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('repo-changed', (event) => {
      if (event.payload === repoPath) {
        handleRefresh();
        // Re-fetch file diff if one is selected (staged/unstaged status may have changed)
        // Use refetchFileDiff directly to avoid toggling off via handleFileSelect
        if (selectedFile) {
          refetchFileDiff(selectedFile.path, selectedFile.kind);
        }
        // Do NOT clear selectedCommitOid — historical commits don't change
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  });

  async function handleClose() {
    if (repoPath) {
      try {
        await safeInvoke('close_repo', { path: repoPath });
      } catch {
        // State is cleaned up regardless of close_repo result
      }
    }
    repoPath = null;
    repoName = '';
    graphKey = 0;
    clearDiff();
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
        {#if selectedFile || selectedCommitOid}
          <DiffPanel fileDiffs={diffFiles} commitDetail={diffCommitDetail} onclose={clearDiff} />
        {:else}
          {#key graphKey}
            <CommitGraph {repoPath} oncommitselect={handleCommitSelect} />
          {/key}
        {/if}
      </div>
      <StagingPanel repoPath={repoPath!} onfileselect={handleFileSelect} />
    </main>
  {/if}
</div>
