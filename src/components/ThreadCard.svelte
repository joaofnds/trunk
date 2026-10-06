<script lang="ts">
// The orphan badge, the file-ref jump affordance, and the diff excerpt are
// panel-context decorations; inline hosts omit those optional props. `variant`
// swaps width/padding tokens between the panel and inline hosts.

import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { externalLinks } from "../lib/external-links.js";
import { gapLength } from "../lib/full-file-anchor.js";
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
import type { Side, Thread, ThreadState } from "../lib/types.js";
import Button, { type ButtonVariant } from "../lib/ui/Button.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import StatePill from "./review/StatePill.svelte";
import ThreadAuthor from "./review/ThreadAuthor.svelte";
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
let collapsed = $state(false);
const draft = $derived(editor.rootEdit);
const replyDraft = $derived(editor.reply);
const replySaving = $derived(editor.replySaving);

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

// The directory recedes so the file name and the range carry the location.
const locationDir = $derived(
	location === null
		? ""
		: location.path.slice(0, location.path.lastIndexOf("/") + 1),
);
const locationName = $derived(
	location === null ? "" : location.path.slice(locationDir.length),
);

// Parse the comment's cached_excerpt into rendered lines. Diff-source excerpts
// carry +/-/space prefixes per `prefixLine` in diff-anchor.ts; full-file ones
// are plain code with no prefix, broken by a marker where lines were skipped.
// Splitting the gutter out (vs. inlining the `+/-` into the content span) keeps
// copy-paste clean.
interface ParsedLine {
	kind: "add" | "del" | "context" | "plain" | "gap";
	gutter: string;
	content: string;
	skipped: number;
}
interface ExcerptLine extends ParsedLine {
	number: number | null;
}
function parseExcerpt(text: string, source: "Diff" | "FullFile"): ParsedLine[] {
	const lines = text.split("\n");
	if (source === "FullFile") {
		return lines.map((content) => {
			const skipped = gapLength(content);
			return skipped === null
				? { kind: "plain", gutter: " ", content, skipped: 0 }
				: { kind: "gap", gutter: " ", content, skipped };
		});
	}
	return lines.map((line) => {
		if (line.startsWith("+")) {
			return { kind: "add", gutter: "+", content: line.slice(1), skipped: 0 };
		}
		if (line.startsWith("-")) {
			return { kind: "del", gutter: "-", content: line.slice(1), skipped: 0 };
		}
		if (line.startsWith(" ")) {
			return {
				kind: "context",
				gutter: " ",
				content: line.slice(1),
				skipped: 0,
			};
		}
		// Defensive fallback (e.g. blank line in the source slice).
		return { kind: "plain", gutter: " ", content: line, skipped: 0 };
	});
}

// The range bounds the selected lines, while a diff excerpt also holds the
// unselected lines between them. So the excerpt's first numbered line is known
// only when an end of the excerpt is a numbered line, or when the numbered
// lines fill the range exactly. Otherwise no number is shown rather than a
// wrong one.
function firstNumber(
	lines: ParsedLine[],
	otherSide: ParsedLine["kind"],
	range: { start: number; end: number },
): number | null {
	const numbered = lines.filter(
		(line) => line.kind !== otherSide && line.kind !== "gap",
	).length;
	if (lines[0]?.kind !== otherSide) return range.start;
	if (lines[lines.length - 1].kind !== otherSide) {
		return range.end - numbered + 1;
	}
	if (numbered === range.end - range.start + 1) return range.start;
	return null;
}

// The anchored side's line numbers. A line only the other side holds has no
// number on this one, and a gap marker advances past the lines it stands for.
function numberLines(
	lines: ParsedLine[],
	side: Side,
	range: { start: number; end: number },
): ExcerptLine[] {
	const otherSide = side === "New" ? "del" : "add";
	let next = firstNumber(lines, otherSide, range);
	return lines.map((line) => {
		if (next === null || line.kind === otherSide) {
			return { ...line, number: null };
		}
		if (line.kind === "gap") {
			next += line.skipped;
			return { ...line, number: null };
		}
		const number = next;
		next += 1;
		return { ...line, number };
	});
}

const excerptLines = $derived(
	location === null || !thread.cached_excerpt
		? []
		: numberLines(
				parseExcerpt(thread.cached_excerpt, excerptSource),
				thread.anchor?.side ?? "New",
				location,
			),
);

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
	const submittedEditor = editor;
	const submittedDraft = replyDraft;
	if (!submittedDraft.valid || replySaving) return;

	const text = submittedDraft.text;
	const submittedRevision = submittedDraft.revision;
	submittedEditor.setReplySaving(true);
	// addReply reports its own refusal (review-comment-actions.ts) rather than
	// rethrowing, but this still awaits it before clearing the draft so a
	// published-review refusal keeps the typed text on screen until the write
	// settles.
	try {
		const saved = await addReply(repoPath, thread.id, text);
		if (saved && submittedDraft.revision === submittedRevision) {
			submittedDraft.close();
		}
	} finally {
		submittedEditor.setReplySaving(false);
	}
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

// Done is the step the thread is waiting for, so it leads in the success tone;
// dismissing is the step least often meant, so it recedes.
const TRANSITION_VARIANTS: Record<ThreadState, ButtonVariant> = {
	done: "success",
	dismissed: "ghost",
	open: "secondary",
	addressed: "secondary",
};

// Done on a thread the agent addressed confirms the agent's claimed fix.
function transitionLabel(next: ThreadState): string {
	if (next === "done" && thread.state === "addressed") return "Confirm fix";
	return TRANSITION_LABELS[next];
}

const stateActions = $derived(
	thread.allowed_transitions.map((next) => ({
		label: transitionLabel(next),
		variant: TRANSITION_VARIANTS[next],
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

<article class="comment-card comment-card-{variant}">
	<header class="comment-card-header">
		<Button
			icon
			size="xs"
			variant="ghost"
			aria-expanded={!collapsed}
			aria-label={collapsed ? "Expand thread" : "Collapse thread"}
			onclick={() => { collapsed = !collapsed; }}
		>
			{#if collapsed}
				<ChevronRight size={12} aria-hidden="true" />
			{:else}
				<ChevronDown size={12} aria-hidden="true" />
			{/if}
		</Button>
		<span class="thread-state-chip contents"
			><StatePill state={thread.state} /></span
		>
		{#if thread.stale}
			<span class="thread-stale-chip contents"
				><StatePill state="stale" /></span
			>
		{/if}
		{#if orphanLabel}
			<span class="orphan-badge">{orphanLabel}</span>
		{/if}
		{#if location !== null}
			<span
				class="comment-card-fileref min-w-0 truncate font-mono text-small"
				class:comment-card-fileref-dim={orphaned}
			>
				{#if jumpable && onjump}
					<LinkButton aria-label="Jump to code" onclick={() => onjump?.(thread)}
						>{@render fileref()}</LinkButton
					>
				{:else}
					{@render fileref()}
				{/if}
			</span>
		{/if}
		<span class="flex-1"></span>
		{#if !draft.editing}
			<RowAction size="compact" aria-label="Edit comment" onclick={openEdit}>
				<Pencil size={12} aria-hidden="true" />
			</RowAction>
			{#if !thread.published}
				<RowAction
					size="compact"
					tone="danger"
					aria-label="Delete comment"
					onclick={requestDelete}
				>
					<Trash2 size={12} aria-hidden="true" />
				</RowAction>
			{/if}
		{/if}
	</header>

	{#if !collapsed}
		{#if excerptLines.length > 0}
			<div class="comment-card-diff">
				{#each excerptLines as line, i (i)}
					<div class="diff-line diff-line-{line.kind}">
						<span class="diff-number select-none">{line.number ?? ""}</span>
						<span class="diff-gutter select-none">{line.gutter}</span>
						<span class="diff-content select-text">{line.content}</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Comment text stays at full --color-text even when orphaned (D-08). -->
		<div class="comment-card-body">
			<ThreadAuthor channel={thread.channel} createdAt={thread.created_at} />
			{#if draft.editing}
				<textarea
					bind:value={draft.text}
					rows="3"
					class="card-textarea"
				></textarea>
				<div class="flex gap-1">
					<Button size="sm" onclick={saveEdit} disabled={!draft.valid}
						>Save</Button
					>
					<Button size="sm" onclick={cancelEdit}>Cancel</Button>
				</div>
			{:else if thread.text_html !== undefined}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- backend-sanitized
	           (comrak unsafe-off + ammonia); see commands/markdown.rs -->
				<div
					class="comment-card-text markdown-body select-text"
					use:externalLinks
					>{@html thread.text_html}</div
				>
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
				rows="1"
				placeholder="Reply…"
				aria-label="Reply"
				class="card-textarea flex-1"
				disabled={replySaving}
			></textarea>
			{#if replyDraft.valid || replySaving}
				<Button
					size="sm"
					variant="primary"
					onclick={submitReply}
					disabled={!replyDraft.valid || replySaving}
					>Reply</Button
				>
			{/if}
			<fieldset
				class="flex min-w-auto items-center gap-1"
				aria-label="Thread actions"
			>
				{#each stateActions as action (action.next)}
					<Button
						size="sm"
						variant={action.variant}
						onclick={() => setThreadState(repoPath, thread.id, action.next)}
					>
						{#if action.next === "done"}
							<Check size={12} aria-hidden="true" />
						{/if}
						{action.label}
					</Button>
				{/each}
			</fieldset>
		</div>
	{/if}
</article>

{#snippet fileref()}
	{#if location !== null}
		<span class="fileref-dir">{locationDir}</span
		><span class="fileref-name">{locationName}</span
		><span class="fileref-range">:L{location.start}-L{location.end}</span>
	{/if}
{/snippet}

<style>
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
	font-size: var(--text-callout);
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
	border-bottom: 1px solid var(--color-border);
}

.fileref-dir {
	color: var(--color-text-muted);
}
.fileref-name {
	color: var(--color-text-strong);
	font-weight: var(--weight-medium);
}
.fileref-range {
	color: var(--color-accent);
}
/* Orphan de-emphasis via a solid dim color, not opacity-on-text (which would
     composite the glyph toward the card and drop it below AAA). --fg-3 on the
     card surface is 7.68:1 (AAA) while still reading as muted. */
.comment-card-fileref-dim .fileref-dir,
.comment-card-fileref-dim .fileref-name,
.comment-card-fileref-dim .fileref-range {
	color: var(--color-text-subtle);
}

/* Diff hunk inside the card — line-level red/green backgrounds, no
     syntax highlighting (deferred). */
.comment-card-diff {
	font-family: var(--font-mono);
	font-size: var(--text-small);
	line-height: var(--leading-normal);
	border-bottom: 1px solid var(--color-border);
	background: var(--color-bg);
}
.diff-line {
	display: flex;
	border-left: 2px solid transparent;
}
.diff-line-add {
	background: var(--color-diff-add-bg);
	border-left-color: var(--color-diff-add);
}
.diff-line-del {
	background: var(--color-diff-delete-bg);
	border-left-color: var(--color-diff-delete);
}
.diff-number {
	flex-shrink: 0;
	width: calc(8 * var(--u));
	padding-right: var(--space-1);
	text-align: right;
	color: var(--color-text-subtle);
}
.diff-gutter {
	flex-shrink: 0;
	width: calc(9 * var(--u) / 2);
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

.orphan-badge {
	font-size: var(--text-caption);
	line-height: var(--text-caption--line-height);
	color: var(--color-warning);
	background: var(--color-warning-bg);
	border-radius: var(--radius);
	padding: 0 var(--space-1);
	white-space: nowrap;
}

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

/* One line under the replies: the reply field, then the state actions. */
.thread-reply-composer {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2);
	border-top: 1px solid var(--color-border);
}
.thread-reply-composer .card-textarea {
	resize: none;
	background: var(--color-bg);
}
</style>
