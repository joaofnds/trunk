<script lang="ts">
  import { safeInvoke } from '../lib/invoke.js';
  import type { HeadCommitMessage } from '../lib/types.js';

  interface Props {
    repoPath: string;
    stagedCount: number;
    onsubjectchange?: (value: string) => void;
  }

  let { repoPath, stagedCount, onsubjectchange }: Props = $props();

  let subject = $state('');
  let body = $state('');
  let amend = $state(false);
  let committing = $state(false);
  let subjectError = $state('');
  let stagedError = $state('');

  // Clear stagedError when stagedCount changes or amend changes
  $effect(() => {
    // access reactive values to track them
    const _staged = stagedCount;
    const _amend = amend;
    stagedError = '';
  });

  async function handleAmendToggle(checked: boolean) {
    amend = checked;
    if (checked) {
      try {
        const msg = await safeInvoke<HeadCommitMessage>('get_head_commit_message', { path: repoPath });
        subject = msg.subject;
        body = msg.body ?? '';
      } catch (e) {
        console.error('Failed to get HEAD commit message:', e);
      }
    } else {
      subject = '';
      body = '';
    }
  }

  async function handleSubmit() {
    subjectError = '';
    stagedError = '';

    if (!subject.trim()) {
      subjectError = 'Subject is required';
      return;
    }

    if (!amend && stagedCount === 0) {
      stagedError = 'No files staged';
      return;
    }

    committing = true;
    try {
      if (amend) {
        await safeInvoke('amend_commit', {
          path: repoPath,
          subject: subject.trim(),
          body: body.trim() || null,
        });
      } else {
        await safeInvoke('create_commit', {
          path: repoPath,
          subject: subject.trim(),
          body: body.trim() || null,
        });
      }
      subject = '';
      body = '';
      amend = false;
    } catch (e) {
      console.error('Commit failed:', e);
    } finally {
      committing = false;
    }
  }
</script>

<div style="
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
">
  <!-- Subject field -->
  <input
    type="text"
    bind:value={subject}
    placeholder="Summary (required)"
    oninput={(e) => { if (subjectError) subjectError = ''; onsubjectchange?.((e.target as HTMLInputElement).value); }}
    style="
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 12px;
    "
  />
  {#if subjectError}
    <span style="font-size: 11px; color: #f87171;">{subjectError}</span>
  {/if}

  <!-- Body field -->
  <textarea
    bind:value={body}
    rows={3}
    placeholder="Description (optional)"
    style="
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 12px;
      resize: vertical;
    "
  ></textarea>

  <!-- Amend checkbox row -->
  <div style="display: flex; align-items: center; gap: 6px;">
    <input
      id="amend-checkbox"
      type="checkbox"
      checked={amend}
      oninput={(e) => handleAmendToggle((e.target as HTMLInputElement).checked)}
    />
    <label for="amend-checkbox" style="font-size: 12px; color: var(--color-text-muted);">
      Amend previous commit
    </label>
  </div>

  <!-- Staged error -->
  {#if stagedError}
    <span style="font-size: 11px; color: #f87171;">{stagedError}</span>
  {/if}

  <!-- Commit button -->
  <button
    onclick={handleSubmit}
    disabled={committing}
    style="
      width: 100%;
      height: 28px;
      background: var(--color-accent);
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      opacity: {committing ? 0.6 : 1};
    "
  >
    {committing ? 'Committing...' : amend ? 'Amend Commit' : 'Commit'}
  </button>
</div>
