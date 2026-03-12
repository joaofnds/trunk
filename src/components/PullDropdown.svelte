<script lang="ts">
  import { safeInvoke } from '../lib/invoke.js';
  import type { TrunkError } from '../lib/invoke.js';
  import { remoteState } from '../lib/remote-state.svelte.js';

  interface Props {
    repoPath: string;
    disabled: boolean;
  }

  let { repoPath, disabled }: Props = $props();
  let open = $state(false);

  interface PullOption {
    label: string;
    action: () => Promise<void>;
  }

  const options: PullOption[] = [
    {
      label: 'Fetch',
      action: () => runRemote('git_fetch', {}),
    },
    {
      label: 'Fast-forward if possible',
      action: () => runRemote('git_pull', { strategy: 'ff' }),
    },
    {
      label: 'Fast-forward only',
      action: () => runRemote('git_pull', { strategy: 'ff-only' }),
    },
    {
      label: 'Pull (rebase)',
      action: () => runRemote('git_pull', { strategy: 'rebase' }),
    },
  ];

  async function runRemote(cmd: string, extra: Record<string, unknown>) {
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

  function handleOptionClick(opt: PullOption) {
    open = false;
    opt.action();
  }

  function toggle() {
    if (!disabled) open = !open;
  }

  // Close on outside click
  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.pull-dropdown')) {
      open = false;
    }
  }

  $effect(() => {
    if (open) {
      window.addEventListener('click', handleWindowClick, true);
      return () => window.removeEventListener('click', handleWindowClick, true);
    }
  });
</script>

<style>
  .pull-dropdown {
    position: relative;
    display: inline-flex;
  }

  .chevron-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-left: none;
    border-radius: 0 4px 4px 0;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 10px;
    padding: 0 5px;
    height: 100%;
    display: flex;
    align-items: center;
  }
  .chevron-btn:hover:not(:disabled) {
    background: var(--color-border);
    color: var(--color-text);
  }
  .chevron-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .dropdown-panel {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 100;
    margin-top: 2px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    min-width: 180px;
    padding: 4px 0;
  }

  .dropdown-option {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--color-text);
    font-size: 12px;
    padding: 6px 12px;
    cursor: pointer;
  }
  .dropdown-option:hover {
    background: var(--color-accent);
    color: white;
  }
</style>

<div class="pull-dropdown">
  <button class="chevron-btn" onclick={toggle} disabled={disabled} title="Pull options">
    &#9662;
  </button>

  {#if open}
    <div class="dropdown-panel">
      {#each options as opt}
        <button class="dropdown-option" onclick={() => handleOptionClick(opt)}>
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
