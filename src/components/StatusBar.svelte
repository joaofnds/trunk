<script lang="ts">
  import { listen } from '@tauri-apps/api/event';
  import { safeInvoke } from '../lib/invoke.js';
  import { remoteState } from '../lib/remote-state.svelte.js';

  interface Props {
    repoPath: string;
  }

  let { repoPath }: Props = $props();

  let lastResult = $state('');

  // Listen to remote-progress events from backend
  $effect(() => {
    let unlisten: (() => void) | undefined;
    const path = repoPath;

    listen<{ path: string; line: string }>('remote-progress', (event) => {
      if (event.payload.path === path) {
        remoteState.progressLine = event.payload.line;
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  });

  // Track when operation finishes to update lastResult
  $effect(() => {
    if (!remoteState.isRunning && !remoteState.error && remoteState.progressLine === '' && lastResult === '') {
      // idle initial state
    }
  });

  async function handleCancel() {
    try {
      await safeInvoke('cancel_remote_op');
    } catch {
      // ignore cancel errors
    }
    remoteState.isRunning = false;
    remoteState.progressLine = '';
    lastResult = 'Operation cancelled';
  }

  async function handlePullNow() {
    remoteState.isRunning = true;
    remoteState.error = null;
    remoteState.progressLine = '';
    try {
      await safeInvoke('git_pull', { path: repoPath });
      remoteState.isRunning = false;
      remoteState.progressLine = '';
      lastResult = 'Pull complete';
    } catch (e: unknown) {
      remoteState.isRunning = false;
      remoteState.error = e as import('../lib/invoke.js').TrunkError;
    }
  }

  function errorMessage(error: import('../lib/invoke.js').TrunkError): string {
    switch (error.code) {
      case 'auth_failure':
        return 'Authentication failed \u2014 check your SSH key or credential helper';
      case 'non_fast_forward':
        return 'Push rejected (non-fast-forward)';
      case 'no_upstream':
      case 'remote_error':
      default:
        return error.message;
    }
  }
</script>

<style>
  .status-bar {
    height: 26px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-size: 11px;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    gap: 8px;
    user-select: none;
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .cancel-btn {
    background: none;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0 4px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .cancel-btn:hover {
    background: var(--color-border);
    color: var(--color-text);
  }

  .error-text {
    color: var(--color-error, #e55);
  }

  .pull-now-btn {
    background: none;
    border: none;
    color: var(--color-accent);
    cursor: pointer;
    font-size: 11px;
    padding: 0 4px;
    text-decoration: underline;
  }
  .pull-now-btn:hover {
    opacity: 0.8;
  }

  .status-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

<div class="status-bar">
  {#if remoteState.isRunning}
    <span class="spinner"></span>
    <span class="status-text">{remoteState.progressLine || 'Running...'}</span>
    <button class="cancel-btn" onclick={handleCancel} title="Cancel operation">&times;</button>
  {:else if remoteState.error}
    <span class="status-text error-text">
      {errorMessage(remoteState.error)}
      {#if remoteState.error.code === 'non_fast_forward'}
        <button class="pull-now-btn" onclick={handlePullNow}>Pull now</button>
      {/if}
    </span>
  {:else}
    <span class="status-text">{lastResult || 'Ready'}</span>
  {/if}
</div>
