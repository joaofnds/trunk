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
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import MessageAvatar from "./review/MessageAvatar.svelte";
import ThreadMessage from "./review/ThreadMessage.svelte";

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

// More than four replies collapse to the last three, with a control that
// reveals the rest: hiding a single reply would save no room. Expand state
// belongs to the list, never a parent map.
const hiddenReplyCount = $derived(replies.length > 4 ? replies.length - 3 : 0);
const collapsedReplies = $derived(
	hiddenReplyCount > 0 && !repliesExpanded && editingReplyId === null,
);
const visibleReplies = $derived(
	collapsedReplies ? replies.slice(hiddenReplyCount) : replies,
);
const hiddenAuthors = $derived([
	...new Set(replies.slice(0, hiddenReplyCount).map((r) => r.channel)),
]);

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
	{#if collapsedReplies}
		<div class="thread-replies-more">
			<Row
				variant="flush"
				tone="muted"
				onclick={() => {
					repliesExpanded = true;
				}}
			>
				<span class="thread-replies-faces flex pl-1" aria-hidden="true">
					{#each hiddenAuthors as channel (channel)}
						<MessageAvatar {channel} size="sm" />
					{/each}
				</span>
				<span class="text-small font-medium"
					>Show {hiddenReplyCount} more replies</span
				>
			</Row>
		</div>
	{/if}
	<ul class="thread-replies">
		{#each visibleReplies as reply (reply.id)}
			<li class="thread-reply">
				<ThreadMessage channel={reply.channel} createdAt={reply.created_at}>
					{#snippet actions()}
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
								tone="destructive"
								aria-label="Delete reply"
								disabled={replyEditSaving}
								onclick={() => onreplydelete(reply.id)}
							>
								<Trash2 size={12} aria-hidden="true" />
							</RowAction>
						{/if}
					{/snippet}
					{#if editingReplyId === reply.id}
						<textarea
							bind:value={replyEditDraft.text}
							rows="2"
							aria-label="Edit reply"
							class="card-textarea"
							disabled={replyEditSaving}
						></textarea>
						<div class="flex justify-end gap-2">
							<Button
								size="sm"
								variant="ghost"
								onclick={cancelReplyEdit}
								disabled={replyEditSaving}
								>Cancel</Button
							>
							<Button
								size="sm"
								variant="primary"
								onclick={saveReplyEdit}
								disabled={!replyEditDraft.valid || replyEditSaving}
								>Save</Button
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
				</ThreadMessage>
			</li>
		{/each}
	</ul>
{/if}

<style>
/* Inline editor inside a reply: mirrors ThreadCard's own .card-textarea, since
     Svelte scoped styles don't cross component boundaries. */
.card-textarea {
	width: 100%;
	resize: vertical;
	background: var(--color-comment-card-bg);
	color: var(--color-text);
	border: 1px solid var(--color-accent);
	border-radius: var(--radius);
	padding: var(--space-2);
	font-size: var(--text-callout);
	font-family: inherit;
}

.thread-replies-more {
	box-shadow: inset 0 1px 0 var(--color-border);
	background: var(--color-surface);
}
.thread-replies-faces > :global(* + *) {
	margin-left: calc(-1 * var(--u));
}
.thread-replies-faces > :global(*) {
	box-shadow: 0 0 0 2px var(--color-surface);
}
.thread-replies {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
}
.thread-reply {
	box-shadow: inset 0 1px 0 var(--color-border);
}
.thread-reply-text {
	font-size: var(--text-callout);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}
</style>
