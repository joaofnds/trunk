<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { copySha } from "../lib/clipboard.js";
import { fileCountsForOid } from "../lib/comment-counts.js";
import { BODY_CLAMP_LINES, bodyOverflows } from "../lib/commit-body-clamp.js";
import { createDraft } from "../lib/draft.svelte.js";
import { reportErrorToast } from "../lib/error-report.js";
import { pathMenuEntriesOf } from "../lib/file-menu.js";
import { toFileStatusList } from "../lib/file-status.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	addCommitThread,
	addReply,
	deleteReply,
	deleteThread,
	editReply,
	editThread,
	setThreadState,
} from "../lib/review-comment-actions.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import type {
	CommitDetail,
	CommitNav,
	FileDiff,
	FileStatus,
} from "../lib/types.js";
import Avatar from "./Avatar.svelte";
import ThreadCard from "./ThreadCard.svelte";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	commitDetail: CommitDetail;
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

let authorDate = $derived(
	new Date(commitDetail.author_timestamp * 1000).toLocaleString(),
);

// A long body used to push the file list past the bottom of the panel, since
// the body, the notes and the file list share one scroller. The body is clamped
// to a fixed number of lines and the reader opens it when they want it. Keyed
// by OID so selecting another commit starts clamped again rather than inheriting
// the previous commit's expansion.
let expandedBodyOid = $state<string | null>(null);
let bodyExpandable = $derived(bodyOverflows(commitDetail.body));
let bodyClamped = $derived(
	bodyExpandable && expandedBodyOid !== commitDetail.oid,
);

// j/k step older/newer through the same navigate path as the pager, so review
// flows without focusing the graph. Vim-style: j = down = older, k = up = newer.
// Arrow keys are left to CommitGraph's own (container-scoped) handler to avoid
// double-firing; j/k aren't bound anywhere else.
function handlePaneKeydown(e: KeyboardEvent) {
	if (!nav || (e.key !== "j" && e.key !== "k")) return;
	const active = document.activeElement;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement ||
		(active instanceof HTMLElement && active.isContentEditable)
	) {
		return;
	}
	const target = e.key === "j" ? nav.olderOid : nav.newerOid;
	if (target === null) return;
	e.preventDefault();
	onnavigate?.(target);
}

async function showShaContextMenu(e: MouseEvent, oid: string) {
	e.preventDefault();
	const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy SHA",
				action: () => {
					void copySha(oid);
				},
			}),
		],
	});
	await menu.popup();
}

function countOrigin(origin: "Add" | "Delete"): number {
	return fileDiffs.reduce(
		(sum, fd) =>
			sum +
			fd.hunks.reduce(
				(h, hunk) => h + hunk.lines.filter((l) => l.origin === origin).length,
				0,
			),
		0,
	);
}

let totalAdds = $derived(countOrigin("Add"));
let totalDels = $derived(countOrigin("Delete"));

// Commit-level notes (anchor === null) for THIS commit, read from the shared
// rune. Whole-commit notes carry no anchor; they belong to the commit by
// commit_oid (plan §2).
let commitNotes = $derived(
	(reviewComments?.threads ?? []).filter(
		(t) => t.anchor === null && t.commit_oid === commitDetail.oid,
	),
);

const draft = createDraft();
let noteSaving = $state(false);

function openAddNote() {
	draft.open();
}

function cancelAddNote() {
	draft.close();
}

async function saveNote() {
	if (!draft.valid || noteSaving) return;
	noteSaving = true;
	try {
		await addCommitThread(repoPath, commitDetail.oid, draft.text.trim());
		draft.close();
	} catch (e) {
		reportErrorToast(e, "Failed to add note");
	} finally {
		noteSaving = false;
	}
}
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
        >
          {commitDetail.body}
        </div>
        {#if bodyExpandable}
          <button
            type="button"
            class="body-toggle"
            aria-expanded={!bodyClamped}
            onclick={() => {
              expandedBodyOid = bodyClamped ? commitDetail.oid : null;
            }}
          >{bodyClamped ? 'Show more' : 'Show less'}</button>
        {/if}
      {/if}
    </div>

    <!-- Author + parent -->
    <div style="
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--color-border);
      font-size: 11px;
      color: var(--color-text-muted);
    ">
      <div style="display: flex; align-items: center; gap: var(--space-3);">
        <Avatar name={commitDetail.author_name} size={22} />
        <div style="display: flex; flex-direction: column; min-width: 0;">
          <span style="color: var(--fg-0); font-weight: 600;">{commitDetail.author_name}</span>
          <span style="color: var(--fg-3); font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{commitDetail.author_email}</span>
        </div>
        <span style="margin-left: auto; flex-shrink: 0; color: var(--fg-3); font-family: var(--font-mono); font-size: 11px;">{authorDate}</span>
      </div>
      {#if commitDetail.parent_oids.length > 0 || (nav && nav.childOids.length > 0)}
        <div class="topo">
          {#if nav && nav.childOids.length > 0}
            <div class="topo-row">
              <span class="topo-lbl">{nav.childOids.length > 1 ? 'Children' : 'Child'}</span>
              {#each nav.childOids as childOid (childOid)}
                <button
                  type="button"
                  class="chip"
                  title="Go to child {childOid.slice(0, 7)} (right-click to copy SHA)"
                  onclick={() => onnavigate?.(childOid)}
                  oncontextmenu={(e) => showShaContextMenu(e, childOid)}
                ><ArrowUp size={11} />{childOid.slice(0, 7)}</button>
              {/each}
            </div>
          {/if}
          {#if commitDetail.parent_oids.length > 0}
            <div class="topo-row">
              <span class="topo-lbl">{commitDetail.parent_oids.length > 1 ? 'Parents' : 'Parent'}</span>
              {#each commitDetail.parent_oids as parentOid, i (parentOid)}
                <button
                  type="button"
                  class="chip"
                  class:merge={i > 0}
                  title="Go to parent {parentOid.slice(0, 7)} (right-click to copy SHA)"
                  onclick={() => onnavigate?.(parentOid)}
                  oncontextmenu={(e) => showShaContextMenu(e, parentOid)}
                ><ArrowDown size={11} />{parentOid.slice(0, 7)}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Commit-level notes (whole-commit, anchor === null) -->
    <div class="commit-notes">
      <div class="commit-notes-head">
        <span class="commit-notes-title">
          Notes{#if commitNotes.length > 0} ({commitNotes.length}){/if}
        </span>
        {#if !draft.editing}
          <button
            type="button"
            class="add-note-btn"
            onclick={openAddNote}
          >
            <MessageSquarePlus size={14} />
            <span>Add note</span>
          </button>
        {/if}
      </div>

      {#if draft.editing}
        <div class="add-note-composer">
          <textarea
            bind:value={draft.text}
            rows="3"
            placeholder="Leave a note on this commit…"
            class="add-note-textarea"
          ></textarea>
          <div class="add-note-actions">
            <button
              type="button"
              onclick={saveNote}
              disabled={!draft.valid || noteSaving}
            >Save</button>
            <button
              type="button"
              onclick={cancelAddNote}
            >Cancel</button>
          </div>
        </div>
      {/if}

      {#if commitNotes.length > 0}
        <ul class="commit-notes-list">
          {#each commitNotes as comment (comment.id)}
            <li>
              <ThreadCard
                thread={comment}
                variant="inline"
                confirmDelete={false}
                onedit={(id, text) => editThread(repoPath, id, text)}
                onreplyadd={(id, text) => addReply(repoPath, id, text)}
                onstatechange={(id, next) => setThreadState(repoPath, id, next)}
                onreplyedit={(id, text) => editReply(repoPath, id, text)}
                onreplydelete={(id) => deleteReply(repoPath, id)}
                ondelete={(id) => deleteThread(repoPath, id)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>

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
    color: var(--color-text-muted);
    white-space: pre-wrap;
    line-height: 1.5;
    margin-top: var(--space-1);
  }
  .commit-body.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--body-clamp-lines);
    line-clamp: var(--body-clamp-lines);
    overflow: hidden;
  }
  .body-toggle {
    display: block;
    margin-top: var(--space-1);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    color: var(--accent-hi);
  }
  .body-toggle:hover,
  .body-toggle:focus-visible {
    text-decoration: underline;
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

  /* Topology chips — clickable parent/child lineage links. */
  .topo {
    margin-top: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .topo-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .topo-lbl {
    font-size: 10px;
    color: var(--fg-3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    width: 62px;
    flex-shrink: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-sm-h);
    padding: 0 var(--space-2) 0 var(--space-1);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: pointer;
    background: color-mix(in oklch, var(--accent) 12%, transparent);
    color: var(--accent-hi);
    border: 1px solid color-mix(in oklch, var(--accent) 25%, transparent);
  }
  .chip:hover {
    background: color-mix(in oklch, var(--accent) 20%, transparent);
  }
  .chip.merge {
    background: color-mix(in oklch, var(--fg-3) 10%, transparent);
    color: var(--fg-1);
    border-color: var(--color-border);
  }
  .chip.merge:hover {
    background: color-mix(in oklch, var(--fg-3) 18%, transparent);
  }

  /* Commit-level notes block — whole-commit review comments. */
  .commit-notes {
    display: flex;
    flex-direction: column;
  }
  .commit-notes-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--bar-h);
    /* .commit-notes is a flex column, which would otherwise shrink this bar
       below the height it declares. */
    flex-shrink: 0;
    box-shadow: inset 0 -1px 0 var(--color-border);
    padding: 0 var(--space-3);
  }
  .commit-notes-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex: 1;
  }
  .add-note-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    padding: var(--space-1) var(--space-2);
    font-size: 12px;
    flex-shrink: 0;
  }
  .add-note-btn:hover,
  .add-note-btn:focus-visible {
    color: var(--color-text);
    background: var(--color-hover);
  }
  .add-note-composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0 var(--space-3) var(--space-2);
  }
  .add-note-textarea {
    width: 100%;
    resize: vertical;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: var(--space-1) var(--space-2);
    font-size: 12px;
    font-family: inherit;
  }
  .add-note-actions {
    display: flex;
    gap: var(--space-1);
  }
  .add-note-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    font-size: 12px;
  }
  .add-note-actions button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .commit-notes-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    list-style: none;
    margin: 0;
    padding: 0 var(--space-3) var(--space-2);
  }
</style>
