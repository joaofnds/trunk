<script lang="ts">
// Shared GitHub-review-style comment card. One card = one Comment, with an
// inline edit textarea (save/cancel) and a delete action. Extracted from
// ReviewPanel so the inline diff/commit-detail surfaces render the exact same
// card. The card owns its own edit state — a host passes a comment + callbacks
// and nothing else of the editing flow.
//
// The orphan badge, the file-ref jump affordance, and the diff excerpt are
// panel-context decorations; inline hosts omit the optional props and get a bare
// card. `variant` swaps width/padding tokens between the panel and inline hosts.

import { externalLinks } from "../lib/external-links.js";
import type { Thread, ThreadState } from "../lib/types.js";

interface Props {
	comment: Thread;
	onedit: (id: string, text: string) => void;
	ondelete: (id: string) => void;
	// Awaited before the composer/editor clears its draft, so a caller that
	// reports its own refusal (review-comment-actions.ts) keeps the typed
	// text on screen until the write settles.
	onreply: (id: string, text: string) => void | Promise<void>;
	onstatechange: (id: string, next: ThreadState) => void;
	onreplyedit: (id: string, text: string) => void | Promise<void>;
	ondeletereply: (id: string) => void;
	// When true (default) confirm before deleting (mirrors the panel); when false
	// delete immediately (inline hosts).
	confirmDelete?: boolean;
	// "panel" (default) for the center-pane review panel; "inline" for diff /
	// commit-detail hosts — controls width/padding via theme tokens.
	variant?: "panel" | "inline";
	// Optional panel-only header decorations. Inline hosts omit these.
	onjump?: (comment: Thread) => void;
	jumpable?: boolean;
	orphaned?: boolean;
	orphanLabel?: string | null;
}

let {
	comment,
	onedit,
	ondelete,
	onreply,
	onstatechange,
	onreplyedit,
	ondeletereply,
	confirmDelete = true,
	variant = "panel",
	onjump,
	jumpable = false,
	orphaned = false,
	orphanLabel = null,
}: Props = $props();

let editing = $state(false);
let draftText = $state("");
let replyText = $state("");
let repliesExpanded = $state(false);
let editingReplyId = $state<string | null>(null);
let replyDraftText = $state("");

const draftValid = $derived(draftText.trim().length > 0);
const replyValid = $derived(replyText.trim().length > 0);
const replyDraftValid = $derived(replyDraftText.trim().length > 0);

// More than three replies collapse to the last three, with a control that
// reveals the rest — expand state belongs to the card, never a parent map.
const hiddenReplyCount = $derived(Math.max(comment.replies.length - 3, 0));
const visibleReplies = $derived(
	repliesExpanded || hiddenReplyCount === 0
		? comment.replies
		: comment.replies.slice(-3),
);

// Parse the comment's cached_excerpt into rendered lines. Diff-source excerpts
// carry +/-/space prefixes per `prefixLine` in diff-anchor.ts; full-file ones
// are plain code with no prefix. Splitting the gutter out (vs. inlining the
// `+/-` into the content span) keeps copy-paste clean.
interface ExcerptLine {
	kind: "add" | "del" | "context" | "plain";
	gutter: string;
	content: string;
}
function parseExcerpt(
	text: string,
	source: "Diff" | "FullFile",
): ExcerptLine[] {
	const lines = text.split("\n");
	if (source === "FullFile") {
		return lines.map((content) => ({ kind: "plain", gutter: " ", content }));
	}
	return lines.map((line) => {
		if (line.startsWith("+")) {
			return { kind: "add", gutter: "+", content: line.slice(1) };
		}
		if (line.startsWith("-")) {
			return { kind: "del", gutter: "-", content: line.slice(1) };
		}
		if (line.startsWith(" ")) {
			return { kind: "context", gutter: " ", content: line.slice(1) };
		}
		// Defensive fallback (e.g. blank line in the source slice).
		return { kind: "plain", gutter: " ", content: line };
	});
}

function openEdit() {
	draftText = comment.text;
	editing = true;
}

function cancelEdit() {
	editing = false;
	draftText = "";
}

function saveEdit() {
	if (!draftValid) return;
	const text = draftText;
	editing = false;
	draftText = "";
	onedit(comment.id, text);
}

async function submitReply() {
	if (!replyValid) return;
	const text = replyText;
	await onreply(comment.id, text);
	replyText = "";
}

function openReplyEdit(replyId: string, text: string) {
	editingReplyId = replyId;
	replyDraftText = text;
}

function cancelReplyEdit() {
	editingReplyId = null;
	replyDraftText = "";
}

async function saveReplyEdit() {
	if (!replyDraftValid || editingReplyId === null) return;
	const id = editingReplyId;
	const text = replyDraftText;
	await onreplyedit(id, text);
	editingReplyId = null;
	replyDraftText = "";
}

// The UI's slice of the transition matrix (spec §2): `open|addressed ->
// done|dismissed`, `addressed -> open`, `done|dismissed -> open`. Nothing
// here ever offers `addressed` — that is the agent's claim by definition, and
// no UI control may claim it.
function humanActionsFor(
	state: ThreadState,
): { label: string; next: ThreadState }[] {
	switch (state) {
		case "open":
			return [
				{ label: "Mark done", next: "done" },
				{ label: "Dismiss", next: "dismissed" },
			];
		case "addressed":
			return [
				{ label: "Mark done", next: "done" },
				{ label: "Dismiss", next: "dismissed" },
				{ label: "Reopen", next: "open" },
			];
		case "done":
		case "dismissed":
			return [{ label: "Reopen", next: "open" }];
	}
}

const stateActions = $derived(humanActionsFor(comment.state));

async function confirmedDeletion(
	prompt: string,
	title: string,
): Promise<boolean> {
	if (!confirmDelete) return true;
	const { ask } = await import("@tauri-apps/plugin-dialog");
	return ask(prompt, { title, kind: "warning" });
}

async function requestDelete() {
	const confirmed = await confirmedDeletion(
		"Delete this comment? This cannot be undone.",
		"Delete comment",
	);
	if (!confirmed) return;
	ondelete(comment.id);
}

async function requestDeleteReply(replyId: string) {
	const confirmed = await confirmedDeletion(
		"Delete this reply? This cannot be undone.",
		"Delete reply",
	);
	if (!confirmed) return;
	ondeletereply(replyId);
}
</script>

<div class="comment-card comment-card-{variant}">
  <!-- Header: file ref (jump affordance) + orphan badge + actions -->
  <header class="comment-card-header">
    {#if comment.anchor !== null}
      {#if jumpable && onjump}
        <button
          type="button"
          aria-label="Jump to code"
          onclick={() => onjump?.(comment)}
          class="jump-ref font-mono comment-card-fileref"
        >{comment.anchor.file_path}:L{comment.anchor.start_line}-L{comment.anchor.end_line}</button>
      {:else}
        <span
          class="font-mono comment-card-fileref"
          class:comment-card-fileref-dim={orphaned}
        >{comment.anchor.file_path}:L{comment.anchor.start_line}-L{comment.anchor.end_line}</span>
      {/if}
    {/if}
    <span class="comment-card-spacer"></span>
    {#if orphanLabel}
      <span class="orphan-badge">{orphanLabel}</span>
    {/if}
    <span class="comment-card-channel">{comment.channel}</span>
    <span class="thread-state-chip thread-state-{comment.state}">{comment.state}</span>
    {#each stateActions as action (action.next)}
      <button
        type="button"
        class="card-action"
        onclick={() => onstatechange(comment.id, action.next)}
      >{action.label}</button>
    {/each}
    {#if !editing}
      <button
        type="button"
        class="card-action"
        onclick={openEdit}
      >Edit</button>
      {#if !comment.published}
        <button
          type="button"
          class="card-action card-action-danger"
          onclick={requestDelete}
        >Delete</button>
      {/if}
    {/if}
  </header>

  <!-- Diff hunk: line-anchored comments only. The cached_excerpt is the
       canonical body; render with red/green per-line bg for Diff-source +/-
       lines, plain for full-file content. No syntax highlighting (the project's
       syntect-based path isn't wired into the panel — deferred). -->
  {#if comment.anchor !== null && comment.cached_excerpt}
    <div class="comment-card-diff">
      {#each parseExcerpt(comment.cached_excerpt, comment.anchor.source) as line, i (i)}
        <div class="diff-line diff-line-{line.kind}">
          <span class="diff-gutter select-none">{line.gutter}</span>
          <span class="diff-content select-text">{line.content}</span>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Body: comment text or inline editor (D-10). Comment text stays at full
       --color-text even when orphaned (D-08). -->
  <div class="comment-card-body">
    {#if editing}
      <textarea
        bind:value={draftText}
        rows="3"
        class="card-textarea"
      ></textarea>
      <div class="card-editor-actions">
        <button
          type="button"
          onclick={saveEdit}
          disabled={!draftValid}
        >Save</button>
        <button
          type="button"
          onclick={cancelEdit}
        >Cancel</button>
      </div>
    {:else if comment.text_html !== undefined}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- backend-sanitized
           (comrak unsafe-off + ammonia); see commands/markdown.rs -->
      <div class="comment-card-text markdown-body select-text" use:externalLinks>{@html comment.text_html}</div>
    {:else}
      <span class="comment-card-text select-text">{comment.text}</span>
    {/if}
  </div>

  {#if comment.replies.length > 0}
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
            {#if !comment.published}
              <button
                type="button"
                class="thread-reply-delete"
                onclick={() => requestDeleteReply(reply.id)}
              >Delete reply</button>
            {/if}
          </div>
          {#if editingReplyId === reply.id}
            <textarea
              bind:value={replyDraftText}
              rows="2"
              aria-label="Edit reply"
              class="card-textarea"
            ></textarea>
            <div class="card-editor-actions">
              <button
                type="button"
                onclick={saveReplyEdit}
                disabled={!replyDraftValid}
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

  <div class="thread-reply-composer">
    <textarea
      bind:value={replyText}
      rows="2"
      placeholder="Reply…"
      aria-label="Reply"
      class="card-textarea"
    ></textarea>
    <button
      type="button"
      onclick={submitReply}
      disabled={!replyValid}
    >Reply</button>
  </div>
</div>

<style>
  .jump-ref:hover,
  .jump-ref:focus-visible {
    color: var(--color-accent);
    text-decoration: underline;
  }

  /* GitHub-review-style card per comment. */
  .comment-card {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-comment-card-bg);
    overflow: hidden;
    /* Own the typography so the card renders identically regardless of the
       host's inherited font — the inline diff host and the review panel pass
       different defaults, which is why the body prose drifted in size. */
    font-family: var(--font-sans);
    font-size: 12px;
  }
  /* Inline hosts (diff / commit-detail) span the full row width naturally; the
     panel card sits inside the per-commit list. The variants exist so width and
     padding can diverge without a host-side override. */
  .comment-card-inline {
    width: 100%;
  }
  .comment-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--color-comment-card-header-bg);
    border-bottom: 1px solid var(--color-border);
    font-size: 11px;
  }
  .comment-card-spacer { flex: 1; }
  .comment-card-fileref {
    font-size: 11px;
    line-height: 1.4;
    color: var(--color-text-muted);
    background: transparent;
    border: none;
    padding: 0;
    text-align: left;
    font-family: inherit;
    cursor: pointer;
  }
  /* Orphan de-emphasis via a solid dim color, not opacity-on-text (which would
     composite the glyph toward the card and drop it below AAA). --fg-3 on the
     card surface is 7.68:1 (AAA) while still reading as muted. */
  .comment-card-fileref-dim { color: var(--fg-3); }

  /* Diff hunk inside the card — line-level red/green backgrounds, no
     syntax highlighting (deferred). */
  .comment-card-diff {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    border-bottom: 1px solid var(--color-border);
  }
  .diff-line {
    display: flex;
  }
  .diff-line-add { background: var(--color-diff-add-bg); }
  .diff-line-del { background: var(--color-diff-delete-bg); }
  .diff-line-context,
  .diff-line-plain { background: transparent; }
  .diff-gutter {
    flex-shrink: 0;
    width: 18px;
    padding: 0 4px;
    text-align: center;
    color: var(--color-text-muted);
  }
  .diff-content {
    flex: 1;
    min-width: 0;
    padding-right: 8px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* Body */
  .comment-card-body {
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .comment-card-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Inline action buttons in the header. */
  .card-action {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0 4px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .card-action:hover,
  .card-action:focus-visible { color: var(--color-text); }
  .card-action-danger { color: var(--color-danger); }
  .card-action-danger:hover,
  .card-action-danger:focus-visible { color: var(--color-danger); }

  /* Orphan badge */
  .orphan-badge {
    font-size: 11px;
    line-height: 1.4;
    color: var(--color-warning);
    background: var(--color-warning-bg);
    border-radius: 4px;
    padding: 0 6px;
    white-space: nowrap;
  }

  /* Root channel chip — mirrors .thread-reply-channel so the root's
     attribution reads the same as a reply's. */
  .comment-card-channel {
    font-size: 10px;
    line-height: 1.4;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--color-text-muted);
    background: var(--color-muted-bg);
    border-radius: 4px;
    padding: 0 6px;
    white-space: nowrap;
  }

  /* Thread state chip — color carries no meaning alone; the text is the
     state's own name, so it survives color blindness and grayscale. */
  .thread-state-chip {
    font-size: 10px;
    line-height: 1.4;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    border-radius: 4px;
    padding: 0 6px;
    white-space: nowrap;
    background: var(--color-muted-bg);
  }
  .thread-state-open { color: var(--color-thread-open); }
  .thread-state-addressed { color: var(--color-thread-addressed); }
  .thread-state-done { color: var(--color-thread-done); }
  .thread-state-dismissed { color: var(--color-thread-dismissed); }

  /* Inline editor inside the body. */
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

  /* Reply composer, always available under a thread's replies. */
  .thread-reply-composer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border-top: 1px solid var(--color-border);
  }
  .thread-reply-composer .card-textarea {
    font-size: 12px;
  }
  .thread-reply-composer button {
    align-self: flex-end;
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 12px;
  }
  .thread-reply-composer button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
