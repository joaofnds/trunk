<script lang="ts">
  import { safeInvoke } from '../lib/invoke.js';
  import type { TrunkError } from '../lib/invoke.js';
  import { remoteState } from '../lib/remote-state.svelte.js';
  import { undoRedoState, pushToRedoStack, popFromRedoStack } from '../lib/undo-redo.svelte.js';
  import { listen } from '@tauri-apps/api/event';
  import PullDropdown from './PullDropdown.svelte';
  import InputDialog from './InputDialog.svelte';

  interface Props {
    repoPath: string;
  }

  let { repoPath }: Props = $props();

  // Branch creation dialog state
  let branchDialogOpen = $state(false);

  // Undo/redo state
  let canUndo = $state(false);

  async function checkUndoAvailable() {
    try {
      canUndo = await safeInvoke<boolean>('check_undo_available', { path: repoPath });
    } catch {
      canUndo = false;
    }
  }

  // Check undo availability on mount and repo changes
  $effect(() => {
    // Re-run when repoPath changes
    void repoPath;
    checkUndoAvailable();

    const unlistenPromise = listen<string>('repo-changed', (event) => {
      if (event.payload === repoPath) {
        checkUndoAvailable();
      }
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  });

  async function handleUndo() {
    try {
      const result = await safeInvoke<{ subject: string; body: string | null }>('undo_commit', { path: repoPath });
      pushToRedoStack({ subject: result.subject, body: result.body });
    } catch (e) {
      console.error('undo failed:', e);
    }
  }

  async function handleRedo() {
    const entry = popFromRedoStack();
    if (!entry) return;
    try {
      await safeInvoke('redo_commit', {
        path: repoPath,
        subject: entry.subject,
        body: entry.body,
      });
    } catch (e) {
      console.error('redo failed:', e);
      // Push back on failure
      pushToRedoStack(entry);
    }
  }

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
      await safeInvoke('stash_save', { path: repoPath, message: '' });
    } catch (e) {
      console.error('stash_save failed:', e);
    }
  }

  async function handlePop() {
    try {
      await safeInvoke('stash_pop', { path: repoPath, index: 0 });
    } catch (e) {
      console.error('stash_pop failed:', e);
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
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    padding: 0 12px;
    user-select: none;
  }

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 2px;
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

</style>

<div class="toolbar">
  <div class="toolbar-group">
    <button class="toolbar-btn" disabled={!canUndo} onclick={handleUndo}>
      &#8617; Undo
    </button>
    <button class="toolbar-btn" disabled={undoRedoState.redoStack.length === 0} onclick={handleRedo}>
      &#8618; Redo
    </button>
  </div>

  <div class="toolbar-group">
    <div class="btn-group">
      <button class="toolbar-btn" disabled={remoteState.isRunning} onclick={handlePull}>
        &#8595; Pull
      </button>
      <PullDropdown {repoPath} disabled={remoteState.isRunning} />
    </div>
    <button class="toolbar-btn" disabled={remoteState.isRunning} onclick={handlePush}>
      &#8593; Push
    </button>
  </div>

  <div class="toolbar-group">
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
</div>

{#if branchDialogOpen}
  <InputDialog
    title="Create Branch"
    fields={[{ key: 'name', label: 'Branch name', placeholder: 'feature/my-branch', required: true }]}
    onsubmit={handleBranchCreate}
    oncancel={() => (branchDialogOpen = false)}
  />
{/if}
