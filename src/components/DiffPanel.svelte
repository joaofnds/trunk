<script lang="ts">
  import type { FileDiff, CommitDetail } from '../lib/types.js';

  interface Props {
    fileDiffs: FileDiff[];
    commitDetail: CommitDetail | null;
  }

  let { fileDiffs, commitDetail }: Props = $props();

  let authorTimestamp = $derived(
    commitDetail ? new Date(commitDetail.author_timestamp * 1000).toLocaleString() : ''
  );

  let committerTimestamp = $derived(
    commitDetail ? new Date(commitDetail.committer_timestamp * 1000).toLocaleString() : ''
  );

  let committerDiffers = $derived(
    commitDetail !== null &&
    (commitDetail.committer_name !== commitDetail.author_name ||
     commitDetail.committer_email !== commitDetail.author_email)
  );

  function lineBackground(origin: string): string {
    if (origin === 'Add') return 'rgba(74, 222, 128, 0.1)';
    if (origin === 'Delete') return 'rgba(248, 113, 113, 0.1)';
    return 'transparent';
  }

  function lineColor(origin: string): string {
    if (origin === 'Add') return '#4ade80';
    if (origin === 'Delete') return '#f87171';
    return 'var(--color-text)';
  }

  function originSymbol(origin: string): string {
    if (origin === 'Add') return '+';
    if (origin === 'Delete') return '-';
    return ' ';
  }
</script>

<div style="
  width: 400px;
  min-width: 400px;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--color-border);
  overflow-y: auto;
">

  {#if commitDetail}
    <!-- SECTION 1: Commit metadata header -->
    <div style="
      padding: 10px 12px;
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0;
    ">
      <!-- OID -->
      <div style="
        font-family: monospace;
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text-muted);
        margin-bottom: 2px;
      ">
        {commitDetail.short_oid}
      </div>
      <div style="
        font-family: monospace;
        font-size: 10px;
        color: var(--color-text-muted);
        margin-bottom: 8px;
        word-break: break-all;
      ">
        {commitDetail.oid}
      </div>

      <!-- Author -->
      <div style="font-size: 12px; color: var(--color-text); margin-bottom: 2px;">
        <span style="color: var(--color-text-muted); font-size: 11px;">Author: </span>
        {commitDetail.author_name} &lt;{commitDetail.author_email}&gt;
      </div>
      <div style="font-size: 11px; color: var(--color-text-muted); margin-bottom: 6px;">
        {authorTimestamp}
      </div>

      <!-- Committer (only when differs from author) -->
      {#if committerDiffers}
        <div style="font-size: 12px; color: var(--color-text); margin-bottom: 2px;">
          <span style="color: var(--color-text-muted); font-size: 11px;">Committer: </span>
          {commitDetail.committer_name} &lt;{commitDetail.committer_email}&gt;
        </div>
        <div style="font-size: 11px; color: var(--color-text-muted); margin-bottom: 6px;">
          {committerTimestamp}
        </div>
      {/if}

      <!-- Commit message -->
      <div style="
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text);
        margin-top: 4px;
      ">
        {commitDetail.summary}
      </div>
      {#if commitDetail.body}
        <div style="
          font-size: 12px;
          color: var(--color-text-muted);
          margin-top: 4px;
          white-space: pre-wrap;
        ">
          {commitDetail.body}
        </div>
      {/if}
    </div>
  {/if}

  <!-- SECTION 2: Empty state -->
  {#if fileDiffs.length === 0 && commitDetail === null}
    <div style="
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--color-text-muted);
      font-size: 13px;
    ">
      Select a file or commit to view its diff
    </div>
  {/if}

  <!-- SECTION 3: File diff list -->
  {#each fileDiffs as fd (fd.path)}
    <div>
      <!-- File header bar -->
      <div style="
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        font-size: 12px;
        font-weight: 500;
        padding: 4px 8px;
        color: var(--color-text);
        flex-shrink: 0;
      ">
        {fd.path}
      </div>

      {#if fd.is_binary}
        <!-- Binary file fallback -->
        <div style="
          padding: 8px;
          color: var(--color-text-muted);
          font-size: 12px;
        ">
          Binary file — no diff available
        </div>
      {:else}
        <!-- Hunks -->
        {#each fd.hunks as hunk}
          <!-- Hunk header -->
          <div style="
            background: var(--color-bg);
            color: var(--color-text-muted);
            font-size: 11px;
            font-family: monospace;
            padding: 2px 8px;
          ">
            {hunk.header}
          </div>

          <!-- Diff lines -->
          {#each hunk.lines as line}
            <div style="
              font-family: monospace;
              font-size: 12px;
              line-height: 1.5;
              padding: 0 8px;
              white-space: pre;
              overflow-x: auto;
              background: {lineBackground(line.origin)};
              color: {lineColor(line.origin)};
            ">{originSymbol(line.origin)}{line.content}</div>
          {/each}
        {/each}
      {/if}
    </div>
  {/each}
</div>
