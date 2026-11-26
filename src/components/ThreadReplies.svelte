<script lang="ts">
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { type Snippet, tick } from "svelte";
import { externalLinks } from "../lib/external-links.js";
import {
	createThreadEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import type { ReviewVisibility } from "../lib/review-visibility.svelte.js";
import { threadTimeline } from "../lib/thread-timeline.js";
import type { Reply, StateChange, ThreadFollow } from "../lib/types.js";
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import { isUnseenAgentReply } from "../lib/unread.js";
import CommentEditor from "./review/CommentEditor.svelte";
import MessageAvatar from "./review/MessageAvatar.svelte";
import ThreadEvent from "./review/ThreadEvent.svelte";
import ThreadFollowEvent from "./review/ThreadFollowEvent.svelte";
import ThreadMessage from "./review/ThreadMessage.svelte";

interface Props {
	replies: readonly Reply[];
	history?: readonly StateChange[];
	follows?: readonly ThreadFollow[];
	// Awaited before the editor clears its draft, so a caller that reports its
	// own refusal (review-comment-actions.ts) keeps the typed text on screen
	// until the write settles.
	onreplyedit: (id: string, text: string) => boolean | Promise<boolean>;
	onreplydelete: (id: string) => void;
	/** The thread is dismissed, so what its replies say recedes with it. */
	dismissed: boolean;
	editorSession?: ThreadEditorSession;
	virtualized?: boolean;
	composer?: Snippet;
	// Watches each unseen agent reply when the card is drawn in the review panel.
	visibility?: ReviewVisibility;
}

let {
	replies,
	history = [],
	follows = [],
	onreplyedit,
	onreplydelete,
	dismissed,
	editorSession,
	virtualized = false,
	composer,
	visibility,
}: Props = $props();

const fallbackEditorSession = createThreadEditorSession();
const editor = $derived(editorSession ?? fallbackEditorSession);
const replyEditDraft = $derived(editor.replyEdit);
const editingReplyId = $derived(editor.editingReplyId);
const replyEditSaving = $derived(editor.replyEditSaving);
const timelineId = $props.id();

const timeline = $derived(threadTimeline(replies, history, follows));
const earlierEntries = $derived.by(() => {
	if (timeline.length <= 4) return [];

	const latestReply = timeline.findLastIndex((entry) => entry.kind === "reply");
	const count = Math.min(
		timeline.length - 3,
		latestReply < 0 ? timeline.length : latestReply,
	);
	return count >= 2 ? timeline.slice(0, count) : [];
});
const earlierCount = $derived(earlierEntries.length);
const editingEarlierReply = $derived(
	earlierEntries.some(
		(entry) => entry.kind === "reply" && entry.key === editingReplyId,
	),
);
const expanded = $derived(editor.repliesExpanded || editingEarlierReply);
const visibleEntries = $derived(
	expanded ? timeline : timeline.slice(earlierCount),
);
const earlierAuthors = $derived([
	...new Set(
		earlierEntries.flatMap((entry) =>
			entry.kind === "reply" ? [entry.reply.channel] : [],
		),
	),
]);
const disclosureLabel = $derived.by(() => {
	const repliesOnly = earlierEntries.every((entry) => entry.kind === "reply");
	if (expanded)
		return repliesOnly ? "Hide earlier replies" : "Hide earlier activity";
	return repliesOnly
		? `Show ${earlierCount} earlier replies`
		: `Show earlier activity (${earlierCount})`;
});

let list: HTMLUListElement | undefined = $state();
let replyEditor: ReturnType<typeof CommentEditor> | undefined = $state();
let earlierHistoryExceedsViewport = $state(false);

$effect(() => {
	const timelineList = list;
	const count = earlierEntries.length;
	const recent = timelineList?.children.item(count);
	const viewport = timelineList?.closest<HTMLElement>(
		".exact-virtual-viewport, .review-body, [data-thread-scroll]",
	);
	if (
		!composer ||
		!expanded ||
		count === 0 ||
		!timelineList ||
		!recent ||
		!viewport
	) {
		earlierHistoryExceedsViewport = false;
		return;
	}

	const measure = () => {
		const height =
			recent.getBoundingClientRect().top -
			timelineList.getBoundingClientRect().top;
		earlierHistoryExceedsViewport =
			viewport.clientHeight > 0 && height > viewport.clientHeight;
	};

	measure();
	const observer = new ResizeObserver(measure);
	observer.observe(timelineList);
	observer.observe(viewport);
	return () => observer.disconnect();
});

function toggleHistory(control: HTMLButtonElement) {
	if (editingEarlierReply) return;

	control.focus({ preventScroll: true });
	editor.setRepliesExpanded(!expanded);
}

async function backToRecent() {
	editor.setRepliesExpanded(false);
	await tick();

	const firstRecent = list?.firstElementChild;
	if (firstRecent instanceof HTMLElement)
		firstRecent.focus({ preventScroll: virtualized });
}

async function openReplyEdit(replyId: string, text: string) {
	if (replyEditSaving) return;

	editor.setEditingReply(replyId);
	replyEditDraft.open(text);
	if (virtualized) {
		await tick();
		replyEditor?.focus();
	}
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
	{#if earlierCount > 0}
		<div class="thread-replies-more">
			<Row
				variant="flush"
				tone="muted"
				aria-expanded={expanded}
				aria-controls={timelineId}
				aria-disabled={editingEarlierReply || undefined}
				onclick={(event) => toggleHistory(event.currentTarget)}
			>
				<span class="thread-replies-faces flex pl-1" aria-hidden="true">
					{#each earlierAuthors as channel (channel)}
						<MessageAvatar {channel} size="sm" />
					{/each}
				</span>
				<span class="text-small font-medium">{disclosureLabel}</span>
			</Row>
		</div>
	{/if}
	<ul
		id={timelineId}
		bind:this={list}
		class="thread-replies"
		class:thread-replies-dismissed={dismissed}
	>
		{#each visibleEntries as entry (entry.key)}
			<li
				class="thread-reply"
				data-thread-entry={entry.key}
				tabindex="-1"
				{@attach entry.kind === "reply" && isUnseenAgentReply(entry.reply)
					? visibility?.replies.watch(entry.reply.id)
					: undefined}
			>
				{#if entry.kind === "change"}
					<ThreadEvent change={entry.change} />
				{:else if entry.kind === "follow"}
					<ThreadFollowEvent follow={entry.follow} />
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
								bind:this={replyEditor}
								bind:text={replyEditDraft.text}
								focusOnMount={!virtualized}
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
								data-thread-reply-body
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

{#if expanded && !editingEarlierReply && earlierHistoryExceedsViewport}
	<div class="thread-replies-more">
		<Row variant="flush" tone="muted" onclick={backToRecent}>
			<span class="text-small font-medium">
				{replies.length > 0
					? "Back to recent replies"
					: "Back to recent activity"}
			</span>
		</Row>
	</div>
{/if}
{@render composer?.()}

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
.thread-replies-more:has(:global(:focus-visible)),
.thread-reply:focus-visible {
	box-shadow: inset 0 0 0 2px var(--color-accent);
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
