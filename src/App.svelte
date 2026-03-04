<script lang="ts">
  import WelcomeScreen from './components/WelcomeScreen.svelte';
  import TabBar from './components/TabBar.svelte';
  import { safeInvoke } from './lib/invoke.js';

  let repoPath = $state<string | null>(null);
  let repoName = $state<string>('');

  function handleOpen(path: string, name: string) {
    repoPath = path;
    repoName = name;
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
  }
</script>

<div class="flex flex-col h-screen" style="background: var(--color-bg);">
  {#if repoPath === null}
    <WelcomeScreen onopen={handleOpen} />
  {:else}
    <TabBar {repoName} onclose={handleClose} />
    <main class="flex-1 overflow-hidden">
      <!-- CommitGraph rendered here in Plan 02-05 -->
    </main>
  {/if}
</div>
