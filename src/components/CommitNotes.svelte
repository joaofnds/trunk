<script lang="ts">
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import { createDraft, type Draft } from "../lib/draft.svelte.js";
import { reportErrorToast } from "../lib/error-report.js";
import {
	addCommitThread,
	deleteThread,
	editThread,
} from "../lib/review-comment-actions.js";
import type { ThreadEditorSession } from "../lib/review-editors.svelte.js";
import { filterThreads, threadMatchesFilter } from "../lib/review-filter.js";
import type { ReviewFilter, Thread } from "../lib/types.js";
import ThreadCard from "./ThreadCard.svelte";

interface Props {
	/** Whole-commit notes (anchor === null) for this commit, already filtered. */
	notes: Thread[];
	repoPath: string;
	commitOid: string;
	reviewFilter?: ReviewFilter;
	activeReviewId?: string | null;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	editorDraftFor?: (
		reviewId: string | null,
		surface: string,
		target: string,
	) => Draft;
}

let {
	notes,
	repoPath,
	commitOid,
	reviewFilter = "all",
	activeReviewId = null,
	editorSessionForThread,
	editorDraftFor,
}: Props = $props();

const visibleNotes = $derived(filterThreads(notes, reviewFilter));

const localDraft = createDraft();
let draft = $state<Draft>(localDraft);

$effect(() => {
	draft =
		editorDraftFor?.(activeReviewId, "commit-note", commitOid) ?? localDraft;
});
let noteSaving = $state(false);

function openAddNote() {
	if (!draft.editing) draft.open();
}

function cancelAddNote() {
	draft.close();
}

async function saveNote() {
	const submittedDraft = draft;
	const submittedCommitOid = commitOid;
	if (!submittedDraft.valid || noteSaving) return;

	const text = submittedDraft.text.trim();
	noteSaving = true;
	try {
		await addCommitThread(repoPath, submittedCommitOid, text);
		submittedDraft.close();
	} catch (e) {
		reportErrorToast(e, "Failed to add note");
	} finally {
		noteSaving = false;
	}
}
</script>

<div
  class="commit-notes"
  style:display={reviewFilter === "none" ? "none" : "flex"}
  aria-hidden={reviewFilter === "none"}
>
  <div class="commit-notes-head">
    <span class="commit-notes-title">
      Notes{#if visibleNotes.length > 0} ({visibleNotes.length}){/if}
    </span>
    {#if !draft.editing && reviewFilter !== "none"}
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
    <div class="add-note-composer" style:display={reviewFilter === "none" ? "none" : "flex"}>
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

  {#if notes.length > 0}
    <ul class="commit-notes-list">
      {#each notes as comment (comment.id)}
        <li style:display={reviewFilter !== "none" && threadMatchesFilter(comment, reviewFilter) ? "list-item" : "none"}>
          <ThreadCard
            thread={comment}
            {repoPath}
            variant="inline"
            confirmDelete={false}
            onedit={(id, text) => editThread(repoPath, id, text)}
            ondelete={(id) => deleteThread(repoPath, id)}
            editorSessionForThread={editorSessionForThread}
          />
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
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
