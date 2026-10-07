<script lang="ts">
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import { createDraft, type Draft } from "../lib/draft.svelte.js";
import { reportErrorToast } from "../lib/error-report.js";
import {
	addCommitThread,
	deleteThread,
	editThread,
} from "../lib/review-comment-actions.js";
import type { ThreadEditorSession } from "../lib/review-editors.svelte.js";
import {
	ALL_THREADS,
	filterThreads,
	threadMatchesFilter,
} from "../lib/review-filter.js";
import type { Delivery, ReviewFilter, Thread } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import ComposerFrame from "./review/ComposerFrame.svelte";
import ThreadCard from "./ThreadCard.svelte";

interface Props {
	/** Whole-commit notes (anchor === null) for this commit, already filtered. */
	notes: Thread[];
	repoPath: string;
	commitOid: string;
	reviewFilter?: ReviewFilter;
	activeReviewId?: string | null;
	/** Whether the active review holds a batch, which a new note joins. */
	batchHeld?: boolean;
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
	reviewFilter = ALL_THREADS,
	activeReviewId = null,
	batchHeld = false,
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

async function saveNote(delivery: Delivery) {
	const submittedDraft = draft;
	const submittedCommitOid = commitOid;
	if (!submittedDraft.valid || noteSaving) return;

	const text = submittedDraft.text.trim();
	const submittedRevision = submittedDraft.revision;
	noteSaving = true;
	try {
		await addCommitThread(repoPath, submittedCommitOid, text, delivery);
		if (submittedDraft.revision === submittedRevision) {
			submittedDraft.close();
		}
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
			Notes{#if visibleNotes.length > 0}
				({visibleNotes.length})
			{/if}
		</span>
		{#if !draft.editing && reviewFilter !== "none"}
			<Button size="sm" variant="ghost" onclick={openAddNote}>
				<MessageSquarePlus size={14} />
				<span>Add note</span>
			</Button>
		{/if}
	</div>

	{#if draft.editing}
		<div
			class="add-note-composer"
			style:display={reviewFilter === "none" ? "none" : "flex"}
		>
			<ComposerFrame
				activeReview={null}
				{activeReviewId}
				placeholder="Leave a note on this commit…"
				bind:text={draft.text}
				busy={noteSaving}
				submitLabel={batchHeld ? "Add to batch" : "Add note"}
				submitDisabled={!draft.valid || noteSaving}
				onsubmit={() => void saveNote(batchHeld ? "hold" : "send")}
				onhold={batchHeld ? undefined : () => void saveNote("hold")}
				oncancel={cancelAddNote}
				onescape={cancelAddNote}
			>
				{#snippet heading()}
					<GitCommitHorizontal
						size={13}
						class="shrink-0 text-accent"
						aria-hidden="true"
					/>
					Note on this commit
				{/snippet}
			</ComposerFrame>
		</div>
	{/if}

	{#if notes.length > 0}
		<ul class="commit-notes-list">
			{#each notes as comment (comment.id)}
				<li
					style:display={reviewFilter !== "none" && threadMatchesFilter(comment, reviewFilter) ? "list-item" : "none"}
				>
					<ThreadCard
						thread={comment}
						{repoPath}
						variant="inline"
						confirmDelete={false}
						onedit={(id, text) => editThread(repoPath, id, text)}
						ondelete={(id) => deleteThread(repoPath, id)}
						{editorSessionForThread}
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
	font-size: var(--text-small);
	font-weight: var(--weight-medium);
	color: var(--color-text-muted);
	text-transform: uppercase;
	letter-spacing: var(--tracking-wider);
	flex: 1;
}
.add-note-composer {
	display: flex;
	flex-direction: column;
	padding: 0 var(--space-3) var(--space-2);
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
