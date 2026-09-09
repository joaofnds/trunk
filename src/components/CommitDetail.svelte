<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { copySha } from "../lib/clipboard.js";
import { fileCountsForOid } from "../lib/comment-counts.js";
import { BODY_CLAMP_LINES, bodyOverflows } from "../lib/commit-body-clamp.js";
import { pathMenuEntriesOf } from "../lib/file-menu.js";
import { toFileStatusList } from "../lib/file-status.js";
import { safeInvoke } from "../lib/invoke.js";
import { focusInEditable, keyChord } from "../lib/keyboard.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import type {
	CommitDetail,
	CommitNav,
	DiffStat,
	FileDiff,
	FileStatus,
} from "../lib/types.js";
import CommitAuthor from "./CommitAuthor.svelte";
import CommitNotes from "./CommitNotes.svelte";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	commitDetail: CommitDetail;
	/** Whole-commit totals; null while they load (the bar shows the file count only). */
	stat?: DiffStat | null;
	fileDiffs: FileDiff[];
	selectedFile: string | null;
	onfileselect: (path: string) => void;
	onclose: () => void;
	repoPath?: string;
	treeViewEnabled?: boolean;
	ontreeviewtoggle?: () => void;
	nav?: CommitNav | null;
	onnavigate?: (oid: string) => void;
	// The shared comments store, threaded from RepoView so the commit-notes block
	// (later task) reads one source of truth. Optional until that render lands.
	reviewComments?: ReviewCommentsManager;
	// Center-pane inline-comments toggle; gates the per-file count badges.
	showInlineComments?: boolean;
}

let {
	commitDetail,
	stat = null,
	fileDiffs,
	selectedFile,
	onfileselect,
	onclose,
	repoPath = "",
	treeViewEnabled = false,
	ontreeviewtoggle,
	nav = null,
	onnavigate,
	reviewComments,
	showInlineComments = false,
}: Props = $props();

// Per-file comment counts for this commit's file list. Gated so the badges
// follow the toggle + an active session; keyed by the commit's own OID so the
// badge can never disagree with what the diff pane shows for the same file.
let fileCommentCounts = $derived(
	showInlineComments && reviewComments?.hasThreads
		? fileCountsForOid(reviewComments.countByFile, commitDetail.oid)
		: new Map<string, number>(),
);

let fileStatusList = $derived<FileStatus[]>(toFileStatusList(fileDiffs));

async function showFileContextMenu(e: MouseEvent, file: FileStatus) {
	e.preventDefault();
	const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
	const menu = await Menu.new({
		items: await Promise.all(
			pathMenuEntriesOf(repoPath, file.path, file.old_path ?? null).map(
				(entry) =>
					MenuItem.new({
						text: entry.text,
						action: () => {
							writeText(entry.value).catch(() => {});
						},
					}),
			),
		),
	});
	await menu.popup();
}

// A long body used to push the file list past the bottom of the panel, since
// the body, the notes and the file list share one scroller. The body is clamped
// to a fixed number of lines and the reader opens it when they want it.
//
// Expansion belongs to the reading rather than to the commit. Reading the OID
// below subscribes the reset to it, so moving away clamps again, and so does
// coming back to a commit expanded earlier. Remembering it per commit instead
// put the file list back below the fold on a second visit.
let bodyExpanded = $state(false);
$effect(() => {
	commitDetail.oid;
	bodyExpanded = false;
});
let bodyExpandable = $derived(bodyOverflows(commitDetail.body));
let bodyClamped = $derived(bodyExpandable && !bodyExpanded);

// j/k step older/newer through the same navigate path as the pager, so review
// flows without focusing the graph. Vim-style: j = down = older, k = up = newer.
// Arrow keys are left to CommitGraph's own (container-scoped) handler.
function handlePaneKeydown(e: KeyboardEvent) {
	if (!nav) return;
	const chord = keyChord(e);
	if (chord !== "j" && chord !== "k") return;
	if (focusInEditable(document.activeElement)) return;

	const target = chord === "j" ? nav.olderOid : nav.newerOid;
	if (target === null) return;

	e.preventDefault();
	onnavigate?.(target);
}

let totalAdds = $derived(stat?.insertions ?? 0);
let totalDels = $derived(stat?.deletions ?? 0);

// Commit-level notes (anchor === null) for THIS commit, read from the shared
// rune. Whole-commit notes carry no anchor; they belong to the commit by
// commit_oid (plan §2).
let commitNotes = $derived(
	(reviewComments?.threads ?? []).filter(
		(t) => t.anchor === null && t.commit_oid === commitDetail.oid,
	),
);
</script>

<svelte:window onkeydown={handlePaneKeydown} />

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
      font-family: monospace;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    ">
      commit: <button type="button" title="Copy SHA" class="sha-copy" style="display: inline-flex; align-items: center; padding: var(--space-1) var(--space-2); border-radius: var(--radius); background: var(--bg-3); color: var(--fg-0);" onclick={() => copySha(commitDetail.oid)}>{commitDetail.short_oid}</button>
    </span>
    {#if nav}
      <span class="pager">
        <button
          type="button"
          class="pager-btn"
          aria-label="Go to newer commit"
          title="Newer commit"
          disabled={nav.newerOid === null}
          aria-disabled={nav.newerOid === null}
          onclick={() => nav?.newerOid && onnavigate?.(nav.newerOid)}
        ><ChevronUp size={13} /></button>
        <span class="pager-pos">{nav.index} / {nav.total}{nav.hasMore ? '+' : ''}</span>
        <button
          type="button"
          class="pager-btn"
          aria-label="Go to older commit"
          title="Older commit"
          disabled={nav.olderOid === null}
          aria-disabled={nav.olderOid === null}
          onclick={() => nav?.olderOid && onnavigate?.(nav.olderOid)}
        ><ChevronDown size={13} /></button>
      </span>
    {/if}
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
        padding: var(--space-1);
        border-radius: var(--radius);
        flex-shrink: 0;
      "
    >✕</button>
  </div>

  <!-- Scrollable content -->
  <div style="flex: 1; overflow-y: auto; min-height: 0;">

    <!-- Commit message -->
    <div style="
      padding: var(--space-3);
      border-bottom: 1px solid var(--color-border);
    ">
      <div class="select-text" style="
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text);
        line-height: 1.4;
        margin-bottom: {commitDetail.body ? 'var(--space-2)' : '0'};
      ">
        {commitDetail.summary}
      </div>
      {#if commitDetail.body}
        <div
          class="select-text commit-body"
          class:clamped={bodyClamped}
          data-testid="commit-body"
          data-clamped={bodyClamped}
          style="--body-clamp-lines: {BODY_CLAMP_LINES};"
        >{commitDetail.body}</div>
        {#if bodyExpandable}
          <button
            type="button"
            class="body-toggle"
            aria-expanded={!bodyClamped}
            onclick={() => {
              bodyExpanded = !bodyExpanded;
            }}
          >
            {#if bodyClamped}
              <ChevronDown size={12} />
            {:else}
              <ChevronUp size={12} />
            {/if}
            <span>{bodyClamped ? 'Show more' : 'Show less'}</span>
          </button>
        {/if}
      {/if}
    </div>

    <!-- Author + parent -->
    <CommitAuthor
      authorName={commitDetail.author_name}
      authorEmail={commitDetail.author_email}
      authorTimestamp={commitDetail.author_timestamp}
      parentOids={commitDetail.parent_oids}
      childOids={nav?.childOids ?? []}
      {onnavigate}
    />

    <!-- Commit-level notes (whole-commit, anchor === null) -->
    <CommitNotes notes={commitNotes} {repoPath} commitOid={commitDetail.oid} />

    <!-- File list -->
    <div>
      <div style="
        height: var(--bar-h);
        padding: 0 var(--space-3);
        display: flex;
        align-items: center;
        box-shadow: inset 0 -1px 0 var(--color-border);
        flex-shrink: 0;
      ">
        <span style="font-size: 12px; font-weight: 500; color: var(--color-text); flex: 1;">
          {fileDiffs.length} file{fileDiffs.length === 1 ? '' : 's'} changed
        </span>
        {#if totalAdds > 0 || totalDels > 0}
          <span style="display: inline-flex; gap: var(--space-2); flex-shrink: 0; margin-right: var(--space-2); font-family: var(--font-mono); font-size: 10.5px;">
            {#if totalAdds > 0}<span style="color: var(--ok);">+{totalAdds}</span>{/if}
            {#if totalDels > 0}<span style="color: var(--err);">−{totalDels}</span>{/if}
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
            {#if treeViewEnabled}
              <FolderTree size={14} />
            {:else}
              <List size={14} />
            {/if}
          </button>
        {/if}
      </div>
      <TreeFileList
        files={fileStatusList}
        treeMode={treeViewEnabled}
        actionLabel=""
        onfileaction={() => {}}
        onfileclick={(path) => onfileselect(path)}
        onfilecontextmenu={(e, _path, file) => showFileContextMenu(e, file)}
        commentCounts={fileCommentCounts}
      />
    </div>

  </div>
</div>

<style>
  /* Commit body. Clamped to a line count rather than given its own scrollbar:
     an inline scroll area inside the panel's own scroller is content readers
     skip past, and it would leave the file list just as far down. */
  .commit-body {
    font-size: 12px;
    color: var(--fg-2);
    line-height: 1.6;
    margin-top: var(--space-2);
    /* Bodies arrive hard-wrapped at the author's terminal width, and some carry
       indented code or lists, so the newlines and the leading spaces are both
       content: `pre-wrap` rather than `pre-line`. The cost is that a line longer
       than this pane wraps a second time and leaves a short remainder under it.
       Narrowing the type and opening the leading keeps that remainder rare at
       the widths this panel is actually used at. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .commit-body.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--body-clamp-lines);
    line-clamp: var(--body-clamp-lines);
    overflow: hidden;
    /* Fade the cut so the clamp reads as text continuing rather than as a
       paragraph that happens to end mid-sentence. */
    mask-image: linear-gradient(to bottom, #000 calc(100% - 1.6em), transparent);
  }

  .body-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-sm-h);
    margin-top: var(--space-1);
    padding: 0 var(--space-2) 0 var(--space-1);
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: var(--bg-2);
    color: var(--fg-2);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
  }
  .body-toggle:hover,
  .body-toggle:focus-visible {
    background: var(--bg-3);
    color: var(--fg-0);
  }

  /* Click-to-copy SHA: reset the button to read as inline mono text. */
  .sha-copy {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: monospace;
    font-size: inherit;
    color: inherit;
  }
  .sha-copy:hover {
    text-decoration: underline;
  }

  /* Toolbar pager — step to the newer/older adjacent commit in graph order. */
  .pager {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
  }
  .pager-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: var(--control-sm-h);
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--fg-2);
    border: 1px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .pager-btn:hover:not(:disabled) {
    color: var(--accent-hi);
    border-color: color-mix(in oklch, var(--accent) 30%, transparent);
  }
  .pager-btn:disabled {
    color: var(--fg-3);
    opacity: 0.4;
    cursor: default;
  }
  .pager-pos {
    font-size: 10px;
    color: var(--fg-3);
    font-family: var(--font-mono);
    padding: 0 var(--space-1);
  }

</style>
