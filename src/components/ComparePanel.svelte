<script lang="ts">
import { ArrowDown, ArrowLeftRight, FolderTree, List } from "@lucide/svelte";
import { copySha } from "../lib/clipboard.js";
import { toFileStatusList } from "../lib/file-status.js";
import { currentMinute } from "../lib/now.svelte.js";
import { relativeLabel } from "../lib/relative-time.js";
import type {
	CommitDetail,
	DiffStat,
	FileDiff,
	FileStatus,
} from "../lib/types.js";
import Avatar from "./Avatar.svelte";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	/** Left/old side of the compare; null is the empty tree (root-based range). */
	base: CommitDetail | null;
	/** Right/new side of the compare. */
	target: CommitDetail;
	fileDiffs: FileDiff[];
	/** Whole-compare totals; null while they load. */
	stat: DiffStat | null;
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
	stat,
	selectedFile,
	onfileselect,
	onswap,
	onclose,
	treeViewEnabled = false,
	ontreeviewtoggle,
}: Props = $props();

let fileStatusList = $derived<FileStatus[]>(toFileStatusList(fileDiffs));
</script>

{#snippet commitCard(commit: CommitDetail)}
  <div style="
    padding: var(--space-2) var(--space-3);
    min-width: 0;
  ">
    <p style="
      margin: 0;
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    ">{commit.summary}</p>
    <div style="display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-1); min-width: 0;">
      <Avatar name={commit.author_name} size={16} />
      <span style="font-size: 12px; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{commit.author_name}</span>
      <span style="font-size: 12px; color: var(--color-text-muted); flex-shrink: 0;">{relativeLabel(commit.author_timestamp, currentMinute())}</span>
      <span style="flex: 1;"></span>
      <button
        type="button"
        title="Copy SHA"
        class="sha-copy"
        style="display: inline-flex; align-items: center; padding: var(--space-1) var(--space-2); border-radius: var(--radius); background: var(--bg-3); color: var(--fg-0); font-family: var(--font-mono); font-size: 11px; flex-shrink: 0;"
        onclick={() => copySha(commit.oid)}
      >{commit.short_oid}</button>
    </div>
  </div>
{/snippet}

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
    gap: var(--space-1);
    flex-shrink: 0;
  ">
    <span style="
      font-size: 11px;
      color: var(--color-text-muted);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-left: var(--space-1);
    ">Comparing</span>
    <button
      type="button"
      aria-label="Swap comparison direction"
      title="Swap comparison direction"
      disabled={base === null}
      aria-disabled={base === null}
      onclick={onswap}
      style="
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

  <!-- Base card → connector → Target card, then totals -->
  <div data-testid="compare-header" style="
    padding: var(--space-3);
    box-shadow: inset 0 -1px 0 var(--color-border);
    flex-shrink: 0;
  ">
    <div style="border: 1px solid var(--color-border); border-radius: var(--radius);">
      {#if base}
        {@render commitCard(base)}
      {:else}
        <div style="
          padding: var(--space-2) var(--space-3);
          font-size: 12px;
          font-style: italic;
          color: var(--color-text-muted);
        ">empty tree</div>
      {/if}
      <div style="position: relative; border-top: 1px solid var(--color-border);">
        <span aria-hidden="true" style="
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: var(--bg-1);
          border: 1px solid var(--color-border);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--color-text-muted);
          position: absolute;
          left: 50%;
          top: 0;
          transform: translate(-50%, -50%);
        "><ArrowDown size={11} /></span>
      </div>
      {@render commitCard(target)}
    </div>
    {#if stat}
      <div style="display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-2); font-size: 12px;">
        <span style="color: var(--color-text-muted);">{stat.files_changed} {stat.files_changed === 1 ? 'file' : 'files'} changed</span>
        <span style="flex: 1;"></span>
        <span style="color: var(--color-diff-add); font-family: var(--font-mono);">+{stat.insertions}</span>
        <span style="color: var(--color-diff-delete); font-family: var(--font-mono);">−{stat.deletions}</span>
      </div>
    {/if}
  </div>

  <!-- File list -->
  <div style="
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
    flex-shrink: 0;
  ">
    <span style="font-size: 11px; color: var(--color-text-muted);">Changed files</span>
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

<style>
  /* Click-to-copy SHA chip. The .sha-copy rules in CommitDetail are
     component-scoped and never reach this panel, so the affordance lives here. */
  .sha-copy {
    cursor: pointer;
  }
  .sha-copy:hover {
    text-decoration: underline;
  }
</style>
