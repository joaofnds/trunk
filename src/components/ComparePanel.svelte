<script lang="ts">
import { ArrowDown, ArrowUpDown, FolderTree, List } from "@lucide/svelte";
import { copySha } from "../lib/clipboard.js";
import { toFileStatusList } from "../lib/file-status.js";
import { currentMinute } from "../lib/now.svelte.js";
import { exactLabel, relativeLabel } from "../lib/relative-time.js";
import { tooltip } from "../lib/tooltip.js";
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
	/** Whole-compare totals; null while they load (the bar shows counts only). */
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
// Count from the list, not stat.files_changed: the stat collapses renames the
// list splits into Deleted + Added, and the count sits right above that list.
// The stat still owns +/- — collapsed totals are the true edit size.
let filesChanged = $derived(fileDiffs.length);
</script>

{#snippet commitCard(commit: CommitDetail)}
  <div style="min-width: 0;">
    <div style="
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text);
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    ">{commit.summary}</div>
    <div style="display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-1); min-width: 0; font-size: 11px;">
      <Avatar name={commit.author_name} size={18} />
      <span style="color: var(--fg-0); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{commit.author_name}</span>
      <span style="color: var(--fg-3); font-family: var(--font-mono); flex-shrink: 0;" use:tooltip={exactLabel(commit.author_timestamp)} aria-label={exactLabel(commit.author_timestamp)}>{relativeLabel(commit.author_timestamp, currentMinute())}</span>
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
    ><ArrowUpDown size={14} /></button>
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

  <!-- Base → Target: open blocks split by a hairline carrying the arrow -->
  <div data-testid="compare-header" style="
    padding: var(--space-3);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  ">
    {#if base}
      {@render commitCard(base)}
    {:else}
      <div style="
        font-size: 12px;
        font-style: italic;
        color: var(--color-text-muted);
      ">empty tree</div>
    {/if}
    <div aria-hidden="true" style="display: flex; align-items: center; gap: var(--space-2); margin: var(--space-2) 0; color: var(--color-text-muted);">
      <span style="flex: 1; border-top: 1px solid var(--color-border);"></span>
      <ArrowDown size={13} />
      <span style="flex: 1; border-top: 1px solid var(--color-border);"></span>
    </div>
    {@render commitCard(target)}
  </div>

  <!-- File list, headed by the same stats bar CommitDetail uses -->
  <div style="
    height: var(--bar-h);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    box-shadow: inset 0 -1px 0 var(--color-border);
    flex-shrink: 0;
  ">
    <span style="font-size: 12px; font-weight: 500; color: var(--color-text); flex: 1;">
      {filesChanged} file{filesChanged === 1 ? '' : 's'} changed
    </span>
    {#if stat && (stat.insertions > 0 || stat.deletions > 0)}
      <span style="display: inline-flex; gap: var(--space-2); flex-shrink: 0; margin-right: var(--space-2); font-family: var(--font-mono); font-size: 10.5px;">
        {#if stat.insertions > 0}<span style="color: var(--ok);">+{stat.insertions}</span>{/if}
        {#if stat.deletions > 0}<span style="color: var(--err);">−{stat.deletions}</span>{/if}
      </span>
    {/if}
    {#if ontreeviewtoggle}
      <button
        role="switch"
        aria-checked={treeViewEnabled}
        aria-label={treeViewEnabled ? 'Switch to list view' : 'Switch to tree view'}
        title={treeViewEnabled ? 'List view' : 'Tree view'}
        onclick={(e) => { e.stopPropagation(); ontreeviewtoggle?.(); }}
        style="
          background: none;
          border: none;
          cursor: pointer;
          color: var(--color-text-muted);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: var(--control-sm-h);
          border-radius: var(--radius);
          flex-shrink: 0;
          padding: 0;
        "
      >
        {#if treeViewEnabled}<FolderTree size={14} />{:else}<List size={14} />{/if}
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
