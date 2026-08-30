<script lang="ts">
import { ArrowLeftRight, FolderTree, List } from "@lucide/svelte";
import { copySha } from "../lib/clipboard.js";
import { toFileStatusList } from "../lib/file-status.js";
import type { CommitDetail, FileDiff, FileStatus } from "../lib/types.js";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	/** Left/old side of the compare; null is the empty tree (root-based range). */
	base: CommitDetail | null;
	/** Right/new side of the compare. */
	target: CommitDetail;
	fileDiffs: FileDiff[];
	selectedFile: string | null;
	onfileselect: (path: string) => void;
	onswap: () => void;
	onclose: () => void;
	treeViewEnabled?: boolean;
	ontreeviewtoggle?: () => void;
}

let {
	base,
	target,
	fileDiffs,
	selectedFile,
	onfileselect,
	onswap,
	onclose,
	treeViewEnabled = false,
	ontreeviewtoggle,
}: Props = $props();

let fileStatusList = $derived<FileStatus[]>(toFileStatusList(fileDiffs));
</script>

<div style="
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-1);
">

  <!-- Toolbar -->
  <div style="
    height: var(--bar-h);
    box-shadow: inset 0 -1px 0 var(--color-border);
    padding: 0 var(--space-2);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  ">
    <span style="
      font-size: 11px;
      color: var(--color-text-muted);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    ">Comparing</span>
    <button
      onclick={onclose}
      aria-label="Close comparison"
      style="
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-muted);
        font-size: 16px;
        line-height: 1;
        padding: var(--space-1);
      "
    >×</button>
  </div>

  <!-- Base → Target header -->
  <div data-testid="compare-header" style="
    padding: var(--space-3);
    box-shadow: inset 0 -1px 0 var(--color-border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex-shrink: 0;
  ">
    <div style="display: flex; align-items: center; gap: var(--space-2); min-width: 0;">
      {#if base}
        <button type="button" title="Copy SHA" class="sha-copy" style="display: inline-flex; align-items: center; padding: var(--space-1) var(--space-2); border-radius: var(--radius); background: var(--bg-3); color: var(--fg-0); font-family: monospace; font-size: 11px;" onclick={() => base && copySha(base.oid)}>{base.short_oid}</button>
      {:else}
        <span style="font-size: 11px; color: var(--color-text-muted); font-style: italic;">empty tree</span>
      {/if}
      <span aria-hidden="true" style="color: var(--color-text-muted);">→</span>
      <button type="button" title="Copy SHA" class="sha-copy" style="display: inline-flex; align-items: center; padding: var(--space-1) var(--space-2); border-radius: var(--radius); background: var(--bg-3); color: var(--fg-0); font-family: monospace; font-size: 11px;" onclick={() => copySha(target.oid)}>{target.short_oid}</button>
      <button
        type="button"
        aria-label="Swap comparison direction"
        title="Swap comparison direction"
        disabled={base === null}
        aria-disabled={base === null}
        onclick={onswap}
        style="
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          padding: var(--space-1);
          border-radius: var(--radius);
          background: none;
          border: none;
          color: var(--color-text-muted);
          cursor: {base === null ? 'default' : 'pointer'};
          opacity: {base === null ? '0.4' : '1'};
        "
      ><ArrowLeftRight size={14} /></button>
    </div>
    <div style="display: flex; flex-direction: column; gap: var(--space-1); font-size: 12px; color: var(--color-text); min-width: 0;">
      {#if base}
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{base.summary}</span>
      {/if}
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{target.summary}</span>
    </div>
  </div>

  <!-- File list -->
  <div style="
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
    flex-shrink: 0;
  ">
    <span style="font-size: 11px; color: var(--color-text-muted);">
      {fileStatusList.length} changed {fileStatusList.length === 1 ? 'file' : 'files'}
    </span>
    {#if ontreeviewtoggle}
      <button
        type="button"
        aria-label={treeViewEnabled ? 'Switch to list view' : 'Switch to tree view'}
        title={treeViewEnabled ? 'List view' : 'Tree view'}
        onclick={ontreeviewtoggle}
        style="background: none; border: none; cursor: pointer; color: var(--color-text-muted); display: inline-flex; padding: var(--space-1);"
      >
        {#if treeViewEnabled}<List size={14} />{:else}<FolderTree size={14} />{/if}
      </button>
    {/if}
  </div>
  <div style="flex: 1; overflow-y: auto; min-height: 0;">
    <TreeFileList
      files={fileStatusList}
      treeMode={treeViewEnabled}
      actionLabel=""
      onfileaction={() => {}}
      onfileclick={(path) => onfileselect(path)}
      selectedPath={selectedFile}
    />
  </div>
</div>
