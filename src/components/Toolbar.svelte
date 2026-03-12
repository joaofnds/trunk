<script lang="ts">
  import { safeInvoke } from '../lib/invoke.js';
  import type { TrunkError } from '../lib/invoke.js';
  import { remoteState } from '../lib/remote-state.svelte.js';
  import PullDropdown from './PullDropdown.svelte';
  import InputDialog from './InputDialog.svelte';

  interface Props {
    repoPath: string;
  }

  let { repoPath }: Props = $props();

  // Branch creation dialog state
  let branchDialogOpen = $state(false);

  async function runRemote(cmd: string, extra: Record<string, unknown> = {}) {
    remoteState.isRunning = true;
    remoteState.error = null;
    remoteState.progressLine = '';
    try {
      await safeInvoke(cmd, { path: repoPath, ...extra });
      remoteState.isRunning = false;
      remoteState.progressLine = '';
    } catch (e: unknown) {
      remoteState.isRunning = false;
      remoteState.error = e as TrunkError;
    }
  }

  function handlePull() {
    runRemote('git_pull');
  }

  function handlePush() {
    runRemote('git_push');
  }

  async function handleStash() {
    try {
      await safeInvoke('stash_save', { path: repoPath });
    } catch {
      // stash errors are non-fatal for UI
    }
  }

  async function handlePop() {
    try {
      await safeInvoke('stash_pop', { path: repoPath });
    } catch {
      // pop errors are non-fatal for UI
    }
  }

  function handleBranch() {
    branchDialogOpen = true;
  }

  async function handleBranchCreate(values: Record<string, string>) {
    branchDialogOpen = false;
    const name = values.name?.trim();
    if (!name) return;
    try {
      await safeInvoke('create_branch', { path: repoPath, name, checkout: true });
    } catch {
      // branch create errors are non-fatal for UI
    }
  }
</script>

<style>
  .toolbar {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: 0 12px;
    user-select: none;
  }

  .toolbar-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text);
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 26px;
  }
  .toolbar-btn:hover:not(:disabled) {
    background: var(--color-border);
  }
  .toolbar-btn:disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }

  .btn-group {
    display: inline-flex;
    align-items: stretch;
  }
  .btn-group .toolbar-btn {
    border-radius: 4px 0 0 4px;
  }

  .separator {
    width: 1px;
    height: 18px;
    background: var(--color-border);
    margin: 0 6px;
    flex-shrink: 0;
  }
</style>

<div class="toolbar">
  <div class="btn-group">
    <button class="toolbar-btn" disabled={remoteState.isRunning} onclick={handlePull}>
      &#8595; Pull
    </button>
    <PullDropdown {repoPath} disabled={remoteState.isRunning} />
  </div>

  <button class="toolbar-btn" disabled={remoteState.isRunning} onclick={handlePush}>
    &#8593; Push
  </button>

  <span class="separator"></span>

  <button class="toolbar-btn" onclick={handleBranch}>
    &#9095; Branch
  </button>

  <button class="toolbar-btn" onclick={handleStash}>
    &#128230; Stash
  </button>

  <button class="toolbar-btn" onclick={handlePop}>
    &#128229; Pop
  </button>
</div>

{#if branchDialogOpen}
  <InputDialog
    title="Create Branch"
    fields={[{ key: 'name', label: 'Branch name', placeholder: 'feature/my-branch', required: true }]}
    onsubmit={handleBranchCreate}
    oncancel={() => (branchDialogOpen = false)}
  />
{/if}
