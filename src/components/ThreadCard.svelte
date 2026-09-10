<script lang="ts">
// The orphan badge, the file-ref jump affordance, and the diff excerpt are
// panel-context decorations; inline hosts omit the optional props and get a bare
// card. `variant` swaps width/padding tokens between the panel and inline hosts.

import { externalLinks } from "../lib/external-links.js";
import {
	addReply,
	deleteReply,
	editReply,
	setThreadState,
} from "../lib/review-comment-actions.js";
import {
	createThreadEditorSession,
	type ThreadEditorSession,
} from "../lib/review-editors.svelte.js";
import type { Thread, ThreadState } from "../lib/types.js";
import ThreadReplies from "./ThreadReplies.svelte";

interface Props {
	thread: Thread;
	repoPath: string;
	onedit: (id: string, text: string) => void;
	ondelete: (id: string) => void;
	// When true (default) confirm before deleting (mirrors the panel); when false
	// delete immediately (inline hosts).
	confirmDelete?: boolean;
	// "panel" (default) for the center-pane review panel; "inline" for diff /
	// commit-detail hosts — controls width/padding via theme tokens.
	variant?: "panel" | "inline";
	// Optional panel-only header decorations. Inline hosts omit these.
	onjump?: (thread: Thread) => void;
	jumpable?: boolean;
	orphaned?: boolean;
	orphanLabel?: string | null;
	editorSession?: ThreadEditorSession;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
}

let {
	thread,
	repoPath,
	onedit,
	ondelete,
	confirmDelete = true,
	variant = "panel",
	onjump,
	jumpable = false,
	orphaned = false,
	orphanLabel = null,
	editorSession,
	editorSessionForThread,
}: Props = $props();

const fallbackEditorSession = createThreadEditorSession();
const editor = $derived(
	editorSessionForThread?.(thread) ?? editorSession ?? fallbackEditorSession,
);
const draft = $derived(editor.rootEdit);
const replyDraft = $derived(editor.reply);

// Where the comment points, whichever shape it holds. A current-file thread
// carries no anchor, so without this it rendered a card with no location at all
// and the user could not tell what it was about. The line shown is the one the
// backend last resolved the block to, falling back to the range at pin time
// before any recompute has run.
const location = $derived.by(() => {
	if (thread.anchor !== null) {
		return {
			path: thread.anchor.file_path,
			start: thread.anchor.start_line,
			end: thread.anchor.end_line,
		};
	}
	const pin = thread.content_pin;
	if (!pin) return null;

	const start = thread.resolved_start_line ?? pin.start_line;
	return {
		path: pin.file_path,
		start,
		end: start + (pin.end_line - pin.start_line),
	};
});

// A current-file excerpt is plain code, like the full-file source: it is the
// file's own lines, with no diff prefixes to strip.
const excerptSource = $derived(thread.anchor?.source ?? "FullFile");

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
	draft.open(thread.text);
}

function cancelEdit() {
	draft.close();
}

function saveEdit() {
	if (!draft.valid) return;
	const text = draft.text;
	draft.close();
	onedit(thread.id, text);
}

async function submitReply() {
	const submittedDraft = replyDraft;
	if (!submittedDraft.valid) return;
	const text = submittedDraft.text;
	// addReply reports its own refusal (review-comment-actions.ts) rather than
	// rethrowing, but this still awaits it before clearing the draft so a
	// published-review refusal keeps the typed text on screen until the write
	// settles.
	await addReply(repoPath, thread.id, text);
	submittedDraft.close();
}

// The card owns only the wording per target state; which targets to offer, and
// in what order, is `thread.allowed_transitions` — the backend's one transition
// matrix (spec §2), precomputed for the human channel. Total over the
// ThreadState union, so a member the human wire never sends today
// ("addressed") still renders instead of crashing.
const TRANSITION_LABELS: Record<ThreadState, string> = {
	done: "Mark done",
	dismissed: "Dismiss",
	open: "Reopen",
	addressed: "Mark addressed",
};

const stateActions = $derived(
	thread.allowed_transitions.map((next) => ({
		label: TRANSITION_LABELS[next],
		next,
	})),
);

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
	ondelete(thread.id);
}

async function requestDeleteReply(replyId: string) {
	const confirmed = await confirmedDeletion(
		"Delete this reply? This cannot be undone.",
		"Delete reply",
	);
	if (!confirmed) return;
	deleteReply(repoPath, replyId);
}
</script>

<div class="comment-card comment-card-{variant}">
  <!-- Header: file ref (jump affordance) + orphan badge + actions -->
  <header class="comment-card-header">
    {#if location !== null}
      {#if jumpable && onjump}
        <button
          type="button"
          aria-label="Jump to code"
          onclick={() => onjump?.(thread)}
          class="jump-ref font-mono comment-card-fileref"
        >{location.path}:L{location.start}-L{location.end}</button>
      {:else}
        <span
          class="font-mono comment-card-fileref"
          class:comment-card-fileref-dim={orphaned}
        >{location.path}:L{location.start}-L{location.end}</span>
      {/if}
    {/if}
    <span class="comment-card-spacer"></span>
    {#if orphanLabel}
      <span class="orphan-badge">{orphanLabel}</span>
    {/if}
    <span class="comment-card-channel">{thread.channel}</span>
    <span class="thread-state-chip thread-state-{thread.state}">{thread.state}</span>
    {#each stateActions as action (action.next)}
      <button
        type="button"
        class="card-action"
        onclick={() => setThreadState(repoPath, thread.id, action.next)}
      >{action.label}</button>
    {/each}
    {#if !draft.editing}
      <button
        type="button"
        class="card-action"
        onclick={openEdit}
      >Edit</button>
      {#if !thread.published}
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
  {#if location !== null && thread.cached_excerpt}
    <div class="comment-card-diff">
      {#each parseExcerpt(thread.cached_excerpt, excerptSource) as line, i (i)}
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
    {#if draft.editing}
      <textarea
        bind:value={draft.text}
        rows="3"
        class="card-textarea"
      ></textarea>
      <div class="card-editor-actions">
        <button
          type="button"
          onclick={saveEdit}
          disabled={!draft.valid}
        >Save</button>
        <button
          type="button"
          onclick={cancelEdit}
        >Cancel</button>
      </div>
    {:else if thread.text_html !== undefined}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- backend-sanitized
           (comrak unsafe-off + ammonia); see commands/markdown.rs -->
      <div class="comment-card-text markdown-body select-text" use:externalLinks>{@html thread.text_html}</div>
    {:else}
      <span class="comment-card-text select-text">{thread.text}</span>
    {/if}
  </div>

  <ThreadReplies
    replies={thread.replies}
    published={thread.published}
    editorSession={editor}
    onreplyedit={(id, text) => editReply(repoPath, id, text)}
    onreplydelete={requestDeleteReply}
  />

  <div class="thread-reply-composer">
    <textarea
      bind:value={replyDraft.text}
      rows="2"
      placeholder="Reply…"
      aria-label="Reply"
      class="card-textarea"
    ></textarea>
    <button
      type="button"
      onclick={submitReply}
      disabled={!replyDraft.valid}
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
    border-radius: var(--radius);
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
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
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
    padding: 0 var(--space-1);
    text-align: center;
    color: var(--color-text-muted);
  }
  .diff-content {
    flex: 1;
    min-width: 0;
    padding-right: var(--space-2);
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* Body */
  .comment-card-body {
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
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
    padding: 0 var(--space-1);
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
    border-radius: var(--radius);
    padding: 0 var(--space-2);
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
    border-radius: var(--radius);
    padding: 0 var(--space-2);
    white-space: nowrap;
  }

  /* Thread state chip — color carries no meaning alone; the text is the
     state's own name, so it survives color blindness and grayscale. */
  .thread-state-chip {
    font-size: 10px;
    line-height: 1.4;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    border-radius: var(--radius);
    padding: 0 var(--space-2);
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
    border-radius: var(--radius);
    padding: var(--space-1) var(--space-2);
    font-size: 12px;
    font-family: inherit;
  }
  .card-editor-actions {
    display: flex;
    gap: var(--space-1);
  }
  .card-editor-actions button {
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
  .card-editor-actions button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Reply composer, always available under a thread's replies. */
  .thread-reply-composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    border-top: 1px solid var(--color-border);
  }
  .thread-reply-composer .card-textarea {
    font-size: 12px;
  }
  .thread-reply-composer button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: flex-end;
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    font-size: 12px;
  }
  .thread-reply-composer button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
