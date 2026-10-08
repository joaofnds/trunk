<script lang="ts">
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { externalLinks } from "../lib/external-links.js";
import {
	createThreadEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import { threadTimeline } from "../lib/thread-timeline.js";
import type { Reply, StateChange } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import CommentEditor from "./review/CommentEditor.svelte";
import MessageAvatar from "./review/MessageAvatar.svelte";
import ThreadEvent from "./review/ThreadEvent.svelte";
import ThreadMessage from "./review/ThreadMessage.svelte";

interface Props {
	replies: readonly Reply[];
	history?: readonly StateChange[];
	// Awaited before the editor clears its draft, so a caller that reports its
	// own refusal (review-comment-actions.ts) keeps the typed text on screen
	// until the write settles.
	onreplyedit: (id: string, text: string) => boolean | Promise<boolean>;
	onreplydelete: (id: string) => void;
	/** The thread is dismissed, so what its replies say recedes with it. */
	dismissed: boolean;
	editorSession?: ThreadEditorSession;
}

let {
	replies,
	history = [],
	onreplyedit,
	onreplydelete,
	dismissed,
	editorSession,
}: Props = $props();

let repliesExpanded = $state(false);
const fallbackEditorSession = createThreadEditorSession();
const editor = $derived(editorSession ?? fallbackEditorSession);
const replyEditDraft = $derived(editor.replyEdit);
const editingReplyId = $derived(editor.editingReplyId);
const replyEditSaving = $derived(editor.replyEditSaving);

// More than four entries collapse to the last three, with a control that
// reveals the rest: hiding a single entry would save no room. Expand state
// belongs to the list, never a parent map.
const timeline = $derived(threadTimeline(replies, history));
const hiddenCount = $derived(timeline.length > 4 ? timeline.length - 3 : 0);
const collapsed = $derived(
	hiddenCount > 0 && !repliesExpanded && editingReplyId === null,
);
const visibleEntries = $derived(
	collapsed ? timeline.slice(hiddenCount) : timeline,
);
const hiddenAuthors = $derived([
	...new Set(
		timeline
			.slice(0, hiddenCount)
			.flatMap((entry) =>
				entry.kind === "reply" ? [entry.reply.channel] : [],
			),
	),
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

{#if timeline.length > 0}
	{#if collapsed}
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
					>Show {hiddenCount} more replies</span
				>
			</Row>
		</div>
	{/if}
	<ul class="thread-replies" class:thread-replies-dismissed={dismissed}>
		{#each visibleEntries as entry (entry.key)}
			<li class="thread-reply">
				{#if entry.kind === "change"}
					<ThreadEvent change={entry.change} />
				{:else}
					{@const reply = entry.reply}
					<ThreadMessage
						channel={reply.channel}
						createdAt={reply.created_at}
						pending={reply.pending}
					>
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
							<RowAction
								size="compact"
								tone="destructive"
								aria-label="Delete reply"
								disabled={replyEditSaving}
								onclick={() => onreplydelete(reply.id)}
							>
								<Trash2 size={12} aria-hidden="true" />
							</RowAction>
						{/snippet}
						{#if editingReplyId === reply.id}
							<CommentEditor
								bind:text={replyEditDraft.text}
								label="Edit reply"
								placeholder="Leave a reply"
								submitLabel="Save"
								submitDisabled={!replyEditDraft.valid || replyEditSaving}
								busy={replyEditSaving}
								onsubmit={() => void saveReplyEdit()}
								oncancel={cancelReplyEdit}
								onescape={cancelReplyEdit}
							/>
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
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
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
	color: var(--color-text-strong);
	font-size: var(--text-body);
	line-height: var(--leading-prose);
	overflow-wrap: anywhere;
}
.thread-replies-dismissed .thread-reply-text {
	color: var(--color-text-subtle);
}
</style>
