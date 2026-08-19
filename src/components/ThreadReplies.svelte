<script lang="ts">
import { createDraft } from "../lib/draft.svelte.js";
import { externalLinks } from "../lib/external-links.js";
import type { Reply } from "../lib/types.js";

interface Props {
	replies: readonly Reply[];
	// The owning thread's published bit — once true, "Delete reply" is hidden
	// (mirrors ThreadCard's own Delete control, criterion 12).
	published: boolean;
	// Awaited before the editor clears its draft, so a caller that reports its
	// own refusal (review-comment-actions.ts) keeps the typed text on screen
	// until the write settles.
	onreplyedit: (id: string, text: string) => void | Promise<void>;
	onreplydelete: (id: string) => void;
}

let { replies, published, onreplyedit, onreplydelete }: Props = $props();

let repliesExpanded = $state(false);
const replyEditDraft = createDraft();
let editingReplyId = $state<string | null>(null);

// More than three replies collapse to the last three, with a control that
// reveals the rest — expand state belongs to the list, never a parent map.
const hiddenReplyCount = $derived(Math.max(replies.length - 3, 0));
const visibleReplies = $derived(
	repliesExpanded || hiddenReplyCount === 0 ? replies : replies.slice(-3),
);

function openReplyEdit(replyId: string, text: string) {
	editingReplyId = replyId;
	replyEditDraft.open(text);
}

function cancelReplyEdit() {
	editingReplyId = null;
	replyEditDraft.close();
}

async function saveReplyEdit() {
	if (!replyEditDraft.valid || editingReplyId === null) return;
	const id = editingReplyId;
	const text = replyEditDraft.text;
	await onreplyedit(id, text);
	editingReplyId = null;
	replyEditDraft.close();
}
</script>

{#if replies.length > 0}
  {#if hiddenReplyCount > 0 && !repliesExpanded}
    <button
      type="button"
      class="thread-replies-expand"
      onclick={() => { repliesExpanded = true; }}
    >Show {hiddenReplyCount} more {hiddenReplyCount === 1 ? "reply" : "replies"}</button>
  {/if}
  <ul class="thread-replies">
    {#each visibleReplies as reply (reply.id)}
      <li class="thread-reply">
        <div class="thread-reply-header">
          <span class="thread-reply-channel">{reply.channel}</span>
          {#if reply.channel === "human" && editingReplyId !== reply.id}
            <button
              type="button"
              class="thread-reply-edit-toggle"
              onclick={() => openReplyEdit(reply.id, reply.text)}
            >Edit reply</button>
          {/if}
          <span class="comment-card-spacer"></span>
          {#if !published}
            <button
              type="button"
              class="thread-reply-delete"
              onclick={() => onreplydelete(reply.id)}
            >Delete reply</button>
          {/if}
        </div>
        {#if editingReplyId === reply.id}
          <textarea
            bind:value={replyEditDraft.text}
            rows="2"
            aria-label="Edit reply"
            class="card-textarea"
          ></textarea>
          <div class="card-editor-actions">
            <button
              type="button"
              onclick={saveReplyEdit}
              disabled={!replyEditDraft.valid}
            >Save</button>
            <button
              type="button"
              onclick={cancelReplyEdit}
            >Cancel</button>
          </div>
        {:else}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- backend-sanitized
               (comrak unsafe-off + ammonia); see commands/markdown.rs -->
          <div class="thread-reply-text markdown-body select-text" use:externalLinks>{@html reply.text_html}</div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .comment-card-spacer { flex: 1; }

  /* Inline editor inside a reply — mirrors ThreadCard's own .card-textarea /
     .card-editor-actions; Svelte scoped styles don't cross component
     boundaries, so the reply-edit textarea needs its own copy here. */
  .card-textarea {
    width: 100%;
    resize: vertical;
    background: var(--color-comment-card-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    font-family: inherit;
  }
  .card-editor-actions {
    display: flex;
    gap: 4px;
  }
  .card-editor-actions button {
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 12px;
  }
  .card-editor-actions button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Expand control for a collapsed reply list. */
  .thread-replies-expand {
    align-self: flex-start;
    margin: 6px 8px 0;
    background: transparent;
    color: var(--color-accent);
    border: none;
    cursor: pointer;
    padding: 0;
    font-size: 11px;
  }

  .thread-replies {
    list-style: none;
    margin: 0;
    padding: 6px 8px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--color-border);
  }
  .thread-reply {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .thread-reply-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .thread-reply-edit-toggle,
  .thread-reply-delete {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .thread-reply-edit-toggle:hover,
  .thread-reply-edit-toggle:focus-visible,
  .thread-reply-delete:hover,
  .thread-reply-delete:focus-visible { color: var(--color-text); }
  .thread-reply-channel {
    align-self: flex-start;
    font-size: 10px;
    line-height: 1.4;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-muted);
    background: var(--color-comment-card-header-bg);
    border-radius: 4px;
    padding: 0 6px;
  }
  .thread-reply-text {
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
