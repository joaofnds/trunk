<script lang="ts">
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import TabBar from './components/TabBar.svelte';
  import CommitGraph from './components/CommitGraph.svelte';
  import BranchSidebar from './components/BranchSidebar.svelte';
  import { safeInvoke } from './lib/invoke.js';

  let repoPath = $state<string | null>(null);
  let repoName = $state<string>('');
  let graphKey = $state(0);

  function handleOpen(path: string, name: string) {
    repoPath = path;
    repoName = name;
  }

  function handleRefresh() {
    graphKey += 1;
  }

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
        {#key graphKey}
          <CommitGraph {repoPath} />
        {/key}
      </div>
      <!-- Phase 4 adds StagingPanel here -->
    </main>
  {/if}
</div>
