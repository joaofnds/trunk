<script lang="ts">
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { externalLinks } from "../lib/external-links.js";
import {
	createThreadEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import type { Reply } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import ThreadAuthor from "./review/ThreadAuthor.svelte";

interface Props {
	replies: readonly Reply[];
	// The owning thread's published bit — once true, "Delete reply" is hidden
	// (mirrors ThreadCard's own Delete control, criterion 12).
	published: boolean;
	// Awaited before the editor clears its draft, so a caller that reports its
	// own refusal (review-comment-actions.ts) keeps the typed text on screen
	// until the write settles.
	onreplyedit: (id: string, text: string) => boolean | Promise<boolean>;
	onreplydelete: (id: string) => void;
	editorSession?: ThreadEditorSession;
}

let { replies, published, onreplyedit, onreplydelete, editorSession }: Props =
	$props();

let repliesExpanded = $state(false);
const fallbackEditorSession = createThreadEditorSession();
const editor = $derived(editorSession ?? fallbackEditorSession);
const replyEditDraft = $derived(editor.replyEdit);
const editingReplyId = $derived(editor.editingReplyId);
const replyEditSaving = $derived(editor.replyEditSaving);

// More than three replies collapse to the last three, with a control that
// reveals the rest — expand state belongs to the list, never a parent map.
const hiddenReplyCount = $derived(Math.max(replies.length - 3, 0));
const visibleReplies = $derived(
	repliesExpanded || hiddenReplyCount === 0 || editingReplyId !== null
		? replies
		: replies.slice(-3),
);

function openReplyEdit(replyId: string, text: string) {
	if (replyEditSaving) return;
	editor.setEditingReply(replyId);
	replyEditDraft.open(text);
}

function cancelReplyEdit() {
	if (replyEditSaving) return;
	editor.setEditingReply(null);
	replyEditDraft.close();
}

async function saveReplyEdit() {
	const submittedEditor = editor;
	const submittedDraft = replyEditDraft;
	const submittedReplyId = editingReplyId;
	if (!submittedDraft.valid || submittedReplyId === null || replyEditSaving)
		return;

	const text = submittedDraft.text;
	const submittedRevision = submittedDraft.revision;
	submittedEditor.setReplyEditSaving(true);
	try {
		const saved = await onreplyedit(submittedReplyId, text);
		if (
			saved === true &&
			submittedEditor.editingReplyId === submittedReplyId &&
			submittedDraft.revision === submittedRevision
		) {
			submittedEditor.setEditingReply(null);
			submittedDraft.close();
		}
	} finally {
		submittedEditor.setReplyEditSaving(false);
	}
}
</script>

{#if replies.length > 0}
	{#if hiddenReplyCount > 0 && !repliesExpanded && editingReplyId === null}
		<span class="thread-replies-more text-small leading-normal">
			<LinkButton tone="accent" onclick={() => { repliesExpanded = true; }}
				>{`Show ${hiddenReplyCount} more ${hiddenReplyCount === 1 ? "reply" : "replies"}`}</LinkButton
			>
		</span>
	{/if}
	<ul class="thread-replies">
		{#each visibleReplies as reply (reply.id)}
			<li
				class="thread-reply"
				class:thread-reply-agent={reply.channel === "agent"}
			>
				<div class="thread-reply-header">
					<ThreadAuthor channel={reply.channel} createdAt={reply.created_at} />
					<span class="flex-1"></span>
					{#if reply.channel === "human" && editingReplyId !== reply.id}
						<RowAction
							size="compact"
							aria-label="Edit reply"
							disabled={replyEditSaving}
							onclick={() => openReplyEdit(reply.id, reply.text)}
						>
							<Pencil size={12} aria-hidden="true" />
						</RowAction>
					{/if}
					{#if !published}
						<RowAction
							size="compact"
							tone="danger"
							aria-label="Delete reply"
							disabled={replyEditSaving}
							onclick={() => onreplydelete(reply.id)}
						>
							<Trash2 size={12} aria-hidden="true" />
						</RowAction>
					{/if}
				</div>
				{#if editingReplyId === reply.id}
					<textarea
						bind:value={replyEditDraft.text}
						rows="2"
						aria-label="Edit reply"
						class="card-textarea"
						disabled={replyEditSaving}
					></textarea>
					<div class="flex gap-1">
						<Button
							size="sm"
							onclick={saveReplyEdit}
							disabled={!replyEditDraft.valid || replyEditSaving}
							>Save</Button
						>
						<Button
							size="sm"
							onclick={cancelReplyEdit}
							disabled={replyEditSaving}
							>Cancel</Button
						>
					</div>
				{:else}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- backend-sanitized
               (comrak unsafe-off + ammonia); see commands/markdown.rs -->
					<div
						class="thread-reply-text markdown-body select-text"
						use:externalLinks
						>{@html reply.text_html}</div
					>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
/* Inline editor inside a reply — mirrors ThreadCard's own .card-textarea;
     Svelte scoped styles don't cross component boundaries, so the reply-edit
     textarea needs its own copy here. */
.card-textarea {
	width: 100%;
	resize: vertical;
	background: var(--color-comment-card-bg);
	color: var(--color-text);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	padding: var(--space-1) var(--space-2);
	font-size: var(--text-callout);
	font-family: inherit;
}

.thread-replies-more {
	display: block;
	padding: var(--space-1) var(--space-2);
	border-top: 1px solid var(--color-border);
}
.thread-replies {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
}
.thread-reply {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-2);
	border-top: 1px solid var(--color-border);
	border-left: 2px solid transparent;
}
/* The agent's turns carry its color down their edge, so a long thread still
     reads as who said what without reading every name. */
.thread-reply-agent {
	border-left-color: var(--color-accent-alt);
	background: color-mix(in oklch, var(--color-accent-alt) 6%, transparent);
}
.thread-reply-header {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
.thread-reply-text {
	font-size: var(--text-callout);
	white-space: pre-wrap;
	word-break: break-word;
}
</style>
