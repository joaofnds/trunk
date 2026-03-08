<script lang="ts">
  import type { FileDiff, CommitDetail } from '../lib/types.js';

  interface Props {
    commitDetail: CommitDetail;
    fileDiffs: FileDiff[];
    selectedFile: string | null;
    onfileselect: (path: string) => void;
    onclose: () => void;
  }

  let { commitDetail, fileDiffs, selectedFile, onfileselect, onclose }: Props = $props();

  let authorDate = $derived(
    new Date(commitDetail.author_timestamp * 1000).toLocaleString()
  );

  let parentShort = $derived(
    commitDetail.parent_oids.length > 0 ? commitDetail.parent_oids[0].slice(0, 7) : null
  );
</script>

<div style="
  width: 240px;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--color-border);
  overflow: hidden;
">

  <!-- Toolbar -->
  <div style="
    height: 32px;
    border-bottom: 1px solid var(--color-border);
    padding: 0 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  ">
    <span style="
      font-size: 11px;
      color: var(--color-text-muted);
      font-family: monospace;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    ">
      commit: {commitDetail.short_oid}
    </span>
    <button
      onclick={onclose}
      aria-label="Close commit detail"
      style="
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-muted);
        font-size: 16px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 3px;
        flex-shrink: 0;
      "
    >✕</button>
  </div>

  <!-- Scrollable content -->
  <div style="flex: 1; overflow-y: auto; min-height: 0;">

    <!-- Commit message -->
    <div style="
      padding: 10px 12px;
      border-bottom: 1px solid var(--color-border);
    ">
      <div style="
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text);
        line-height: 1.4;
        margin-bottom: {commitDetail.body ? '6px' : '0'};
      ">
        {commitDetail.summary}
      </div>
      {#if commitDetail.body}
        <div style="
          font-size: 12px;
          color: var(--color-text-muted);
          white-space: pre-wrap;
          line-height: 1.5;
          margin-top: 4px;
        ">
          {commitDetail.body}
        </div>
      {/if}
    </div>

    <!-- Author + parent -->
    <div style="
      padding: 8px 12px;
      border-bottom: 1px solid var(--color-border);
      font-size: 11px;
      color: var(--color-text-muted);
    ">
      <div style="margin-bottom: 2px; color: var(--color-text);">
        {commitDetail.author_name}
        <span style="color: var(--color-text-muted);">&lt;{commitDetail.author_email}&gt;</span>
      </div>
      <div style="margin-bottom: {parentShort ? '2px' : '0'};">{authorDate}</div>
      {#if parentShort}
        <div>parent: <span style="font-family: monospace;">{parentShort}</span></div>
      {/if}
    </div>

    <!-- File list -->
    <div>
      <div style="
        height: 28px;
        padding: 0 12px;
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
      ">
        <span style="font-size: 12px; font-weight: 500; color: var(--color-text);">
          {fileDiffs.length} file{fileDiffs.length === 1 ? '' : 's'} changed
        </span>
      </div>
      <div role="list">
        {#each fileDiffs as fd (fd.path)}
          <button
            type="button"
            onclick={() => onfileselect(fd.path)}
            style="
              width: 100%;
              height: 26px;
              padding: 0 8px;
              display: flex;
              align-items: center;
              gap: 6px;
              cursor: pointer;
              background: {selectedFile === fd.path ? 'var(--color-surface)' : 'transparent'};
              border: none;
              text-align: left;
            "
          >
            <span style="
              color: var(--color-text-muted);
              font-size: 12px;
              min-width: 14px;
              text-align: center;
            ">✎</span>
            <span style="
              flex: 1;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              font-size: 12px;
              color: var(--color-text);
            ">
              {fd.path}
            </span>
          </button>
        {/each}
      </div>
    </div>

  </div>
</div>
