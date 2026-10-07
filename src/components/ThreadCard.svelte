<script lang="ts">
// The orphan badge, the file-ref jump affordance, and the diff excerpt are
// panel-context decorations. An inline card sits under the code it is on, so
// it names its lines and its review in place of the file and the excerpt.

import Check from "@lucide/svelte/icons/check";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import Pencil from "@lucide/svelte/icons/pencil";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { externalLinks } from "../lib/external-links.js";
import { gapLength } from "../lib/full-file-anchor.js";
import { currentMinute } from "../lib/now.svelte.js";
import { compactLabel } from "../lib/relative-time.js";
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
import { CHANGE_TEXT } from "../lib/thread-timeline.js";
import type {
	Delivery,
	MergedSpan,
	Side,
	Thread,
	ThreadState,
} from "../lib/types.js";
import Button, { type ButtonVariant } from "../lib/ui/Button.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import Tag from "../lib/ui/Tag.svelte";
import CommentEditor from "./review/CommentEditor.svelte";
import FoldBar from "./review/FoldBar.svelte";
import StatePill from "./review/StatePill.svelte";
import ThreadMessage from "./review/ThreadMessage.svelte";
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
	// commit-detail hosts, the compact card with no excerpt.
	variant?: "panel" | "inline";
	// Optional panel-only header decorations. Inline hosts omit these.
	onjump?: (thread: Thread) => void;
	jumpable?: boolean;
	orphaned?: boolean;
	orphanLabel?: string | null;
	// Under its file's header in the panel, the card names only the lines it
	// covers, since the header already names the file.
	scoped?: boolean;
	// The thread the panel's keys act on, and how a click makes it that thread.
	focused?: boolean;
	// Whether the focused card draws the cursor, which only the keys need.
	cursorShown?: boolean;
	onfocusrequest?: () => void;
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
	scoped = false,
	focused = false,
	cursorShown = false,
	onfocusrequest,
	editorSession,
	editorSessionForThread,
}: Props = $props();

const fallbackEditorSession = createThreadEditorSession();
const editor = $derived(
	editorSessionForThread?.(thread) ?? editorSession ?? fallbackEditorSession,
);
// A resolved thread folds to its header and an unresolved one opens, whenever
// the state changes. A toggle holds only while the state it was made in does.
// Only the panel folds: the diff has no toggle, since it measures each card
// once from a hidden copy, so a folded card there could never open again.
let toggle = $state<{ state: ThreadState; collapsed: boolean } | null>(null);
const collapsed = $derived(
	variant === "panel" &&
		(toggle !== null && toggle.state === thread.state
			? toggle.collapsed
			: thread.state === "done" || thread.state === "dismissed"),
);
const peek = $derived(
	thread.text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/[`*]/g, "")
		.replace(/\s+/g, " ")
		.trim(),
);
// The header names the thread's latest move, so a collapsed card still says
// whether the agent claimed it.
const lastChange = $derived(thread.history?.at(-1) ?? null);
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

const scopeLabel = $derived(
	location === null
		? ""
		: location.start === location.end
			? `Line ${location.start}`
			: `Lines ${location.start}–${location.end}`,
);

const orphanReason = $derived(
	orphanLabel ? orphanLabel[0].toUpperCase() + orphanLabel.slice(1) : null,
);

const excerptNote = $derived(
	orphanReason
		? `Saved excerpt. ${orphanReason}.`
		: thread.stale
			? "Saved excerpt. These lines have moved or changed since."
			: null,
);

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
	spans: readonly MergedSpan[];
}
interface ExcerptLine extends ParsedLine {
	number: number | null;
}
function parseExcerpt(
	text: string,
	source: "Diff" | "FullFile",
	spans: readonly (readonly MergedSpan[])[],
): ParsedLine[] {
	return parseLines(text, source).map((line, i) => ({
		...line,
		spans: spans[i] ?? [],
	}));
}
function parseLines(
	text: string,
	source: "Diff" | "FullFile",
): Omit<ParsedLine, "spans">[] {
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

// The excerpt is shown from its least indented line, so a block deep in a
// function keeps its shape without spending the card's width on indentation.
function dedent(lines: ExcerptLine[]): ExcerptLine[] {
	const indents = lines
		.filter((line) => line.kind !== "gap" && line.content.trim() !== "")
		.map((line) => line.content.length - line.content.trimStart().length);
	const indent = indents.length === 0 ? 0 : Math.min(...indents);
	return lines.map((line) =>
		line.kind === "gap"
			? line
			: {
					...line,
					content: line.content.slice(indent),
					spans: shiftSpans(line.spans, indent),
				},
	);
}

// A span's offsets count from the line's code, so the indent the dedent drops
// moves every span back by it, and a span wholly inside the indent goes.
function shiftSpans(
	spans: readonly MergedSpan[],
	by: number,
): readonly MergedSpan[] {
	return spans
		.map((span) => ({
			...span,
			start: Math.max(0, span.start - by),
			end: span.end - by,
		}))
		.filter((span) => span.end > span.start);
}

const excerptLines = $derived(
	location === null || !thread.cached_excerpt
		? []
		: dedent(
				numberLines(
					parseExcerpt(
						thread.cached_excerpt,
						excerptSource,
						thread.excerpt_spans ?? [],
					),
					thread.anchor?.side ?? "New",
					location,
				),
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

async function submitReply(delivery: Delivery) {
	const submittedEditor = editor;
	const submittedDraft = replyDraft;
	if (!submittedDraft.valid || replySaving) return;

	const text = submittedDraft.text;
	const submittedRevision = submittedDraft.revision;
	submittedEditor.setReplySaving(true);
	// addReply reports its own refusal (review-comment-actions.ts) rather than
	// rethrowing, but this still awaits it before clearing the draft so a
	// refused reply keeps the typed text on screen until the write settles.
	try {
		const saved = await addReply(repoPath, thread.id, text, delivery);
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

// Done is the step the thread is waiting for, so it takes the success tone.
const TRANSITION_VARIANTS: Record<ThreadState, ButtonVariant> = {
	done: "success",
	dismissed: "secondary",
	open: "secondary",
	addressed: "secondary",
};

// Dismiss comes first and Mark done last, so the step that closes the thread
// sits at the card's edge, whatever order the wire sends.
const TRANSITION_ORDER: ThreadState[] = [
	"dismissed",
	"addressed",
	"open",
	"done",
];

// A thread still waiting on the human offers only the two ways to settle it.
// Reopen beside Mark done on an addressed thread read as a contradiction, so
// rejecting the agent's claim is left to the panel's O key.
const unsettled = $derived(
	thread.state === "open" || thread.state === "addressed",
);

const stateActions = $derived(
	TRANSITION_ORDER.filter(
		(next) =>
			thread.allowed_transitions.includes(next) &&
			!(unsettled && next === "open"),
	).map((next) => ({
		label: TRANSITION_LABELS[next],
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

let confirmingDelete = $state(false);

function requestDelete() {
	if (confirmDelete) {
		confirmingDelete = true;
		return;
	}
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

<article
	class="comment-card comment-card-{variant}"
	data-thread-id={thread.id}
	tabindex="-1"
	aria-current={focused ? "true" : undefined}
	class:comment-card-cursor={focused && cursorShown}
	onpointerdown={onfocusrequest}
	class:comment-card-resolved={thread.state === "done" ||
		thread.state === "dismissed"}
	class:comment-card-open={!collapsed}
>
	<header class="comment-card-header">
		<!-- An inline card's height comes from a hidden copy measured once, so
		     only the panel's card may change its own height. -->
		{#if variant === "panel"}
			<FoldBar
				noun="thread"
				inset="thread"
				{collapsed}
				ontoggle={() => {
					toggle = { state: thread.state, collapsed: !collapsed };
				}}
			>
				{@render headerContent()}
			</FoldBar>
		{:else}
			<div class="flex min-w-0 flex-1 items-center gap-2 px-1">
				{@render headerContent()}
			</div>
		{/if}
	</header>

	{#if !collapsed}
		{#if variant === "panel" && excerptLines.length > 0}
			<div
				class="comment-card-diff"
				class:comment-card-diff-dim={thread.stale || orphaned}
			>
				{#if excerptNote}
					<p
						class="flex items-center gap-1 px-3 pb-1 font-sans text-small text-text-subtle"
					>
						{excerptNote}
					</p>
				{/if}
				{#each excerptLines as line, i (i)}
					<div class="diff-line diff-line-{line.kind}">
						<span class="diff-number select-none">{line.number ?? ""}</span>
						<span class="diff-gutter select-none">{line.gutter}</span>
						<span class="diff-content select-text"
							>{#if line.spans.length > 0}
								{#each line.spans as span, j (j)}
									<span class={span.syntax_class}
										>{line.content.slice(span.start, span.end)}</span
									>
								{/each}
							{:else}
								{line.content}
							{/if}</span
						>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Comment text stays at full --color-text even when orphaned (D-08). -->
		<ThreadMessage
			channel={thread.channel}
			createdAt={thread.created_at}
			pending={thread.pending}
		>
			{#snippet actions()}
				{#if !draft.editing}
					<RowAction
						size="compact"
						aria-label="Edit comment"
						onclick={openEdit}
					>
						<Pencil size={12} aria-hidden="true" />
					</RowAction>
					<RowAction
						size="compact"
						tone="destructive"
						aria-label="Delete comment"
						onclick={requestDelete}
					>
						<Trash2 size={12} aria-hidden="true" />
					</RowAction>
				{/if}
			{/snippet}
			{#if draft.editing}
				<CommentEditor
					bind:text={draft.text}
					label="Edit comment"
					placeholder="Leave a comment"
					submitLabel="Save"
					submitDisabled={!draft.valid}
					onsubmit={saveEdit}
					oncancel={cancelEdit}
					onescape={cancelEdit}
				/>
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
		</ThreadMessage>

		<ThreadReplies
			replies={thread.replies}
			history={thread.history}
			editorSession={editor}
			onreplyedit={(id, text) => editReply(repoPath, id, text)}
			onreplydelete={requestDeleteReply}
		/>

		<div class="thread-reply-composer flex flex-wrap items-center gap-2 p-2">
			<CommentEditor
				bind:text={replyDraft.text}
				label="Reply"
				placeholder="Reply…"
				submitLabel={thread.batch_held ? "Add to batch" : "Reply"}
				submitDisabled={!replyDraft.valid || replySaving}
				busy={replySaving}
				onsubmit={() => void submitReply(thread.batch_held ? "hold" : "send")}
				onhold={thread.batch_held ? undefined : () => void submitReply("hold")}
				oncancel={() => replyDraft.close()}
				collapsible
			/>
		</div>
	{/if}

	{#if confirmingDelete}
		<div
			class="thread-delete-bar flex items-center gap-2 py-2 pr-2 pl-3 text-callout text-text"
		>
			<span>Delete this thread and its replies? This cannot be undone.</span>
			<span class="flex-1"></span>
			<Button
				size="sm"
				variant="ghost"
				onclick={() => {
					confirmingDelete = false;
				}}
				>Cancel</Button
			>
			<Button size="sm" variant="danger" onclick={() => ondelete(thread.id)}
				>Delete</Button
			>
		</div>
	{/if}
</article>

{#snippet headerContent()}
	<span class="thread-state-chip contents"
		><StatePill state={thread.state} /></span
	>
	{#if variant === "inline"}
		{#if location !== null}
			<span
				class="comment-card-range"
				title="{location.path}:L{location.start}-L{location.end}"
				>{location.start === location.end
					? `L${location.start}`
					: `L${location.start}-L${location.end}`}</span
			>
		{/if}
		<span
			class="shrink-0 font-mono text-small text-text-subtle"
			title="Review {thread.review_id}"
			>{thread.review_id}</span
		>
	{:else if scoped}
		{#if location === null}
			<Tag variant="label" dashed
				><GitCommitHorizontal size={11} aria-hidden="true" />Whole commit</Tag
			>
		{:else if onjump}
			<span class="comment-card-scope pointer-events-auto contents"
				><Tag
					title="{location.path}:L{location.start}-L{location.end}"
					disabled={orphaned || !jumpable}
					onclick={() => onjump?.(thread)}
					>{scopeLabel}</Tag
				></span
			>
		{:else}
			<Tag variant="label">{scopeLabel}</Tag>
		{/if}
	{:else if location !== null}
		<span
			class="comment-card-fileref min-w-0 truncate font-mono text-small"
			class:comment-card-fileref-dim={orphaned}
			class:pointer-events-auto={jumpable && onjump}
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
	{#if thread.stale}
		<span class="thread-stale-chip contents"><StatePill state="stale" /></span>
	{/if}
	{#if orphanReason}
		<span
			class="orphan-badge pointer-events-auto contents"
			title="{orphanReason}. Only the saved excerpt survives."
			><StatePill state="orphaned" /></span
		>
	{/if}
	{#if collapsed}
		<span
			class="min-w-0 flex-1 truncate text-callout text-text-subtle"
			class:line-through={thread.state === "dismissed"}
			>{peek}</span
		>
	{:else}
		<span class="flex-1"></span>
	{/if}
	{#if lastChange}
		<span class="shrink-0 whitespace-nowrap text-small text-text-subtle"
			><span
				class="font-semibold"
				class:text-accent-alt={lastChange.channel === "agent"}
				class:text-text-muted={lastChange.channel === "human"}
				>{lastChange.channel === "agent" ? "Agent" : "You"}</span
			>
			{CHANGE_TEXT[lastChange.state]}
			·
			{compactLabel(
				lastChange.created_at,
				currentMinute(),
			)}</span
		>
	{:else if collapsed}
		{#if thread.replies.length > 0}
			<span class="shrink-0 whitespace-nowrap text-small text-text-subtle"
				>{thread.replies.length}
				{thread.replies.length === 1 ? "reply" : "replies"}</span
			>
		{/if}
	{/if}
	<fieldset
		class="flex min-w-auto items-center gap-1 pointer-events-auto"
		aria-label="Thread actions"
	>
		{#each stateActions as action (action.next)}
			<Button
				size="xs"
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
{/snippet}

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
       host's inherited font: the inline diff host and the review panel pass
       different defaults. */
	font-family: var(--font-sans);
	font-size: var(--text-callout);
}
/* The card takes the focus only to hold the keys, and the cursor edge is what
   shows them where they are. */
.comment-card:focus {
	outline: none;
}
.comment-card-cursor {
	border-color: color-mix(in oklch, var(--color-accent) 55%, transparent);
}
.comment-card-range {
	flex-shrink: 0;
	color: var(--color-text);
	font-family: var(--font-mono);
	font-size: var(--text-small);
	line-height: var(--text-small--line-height);
	font-weight: var(--weight-medium);
}

.comment-card-inline {
	width: 100%;
}
.comment-card-header {
	display: flex;
	height: var(--control-h);
	min-width: 0;
	background: var(--color-comment-card-header-bg);
}
.comment-card-open .comment-card-header {
	box-shadow: var(--shadow-hairline);
}
/* A settled thread recedes: its header drops the tint an open one carries. */
.comment-card-resolved .comment-card-header {
	background: transparent;
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
     composite the glyph toward the card and drop it below AAA). */
.comment-card-fileref-dim .fileref-dir,
.comment-card-fileref-dim .fileref-name,
.comment-card-fileref-dim .fileref-range {
	color: var(--color-text-subtle);
}

/* The saved excerpt: one line per row, cut with an ellipsis rather than
     wrapped, so it reads as the code it was. */
.comment-card-diff {
	font-family: var(--font-mono);
	font-size: var(--text-small);
	line-height: var(--leading-normal);
	background: var(--color-bg);
	box-shadow: var(--shadow-hairline);
	padding: var(--space-1) 0;
}
.diff-line {
	display: grid;
	grid-template-columns: calc(10 * var(--u)) calc(3 * var(--u)) minmax(0, 1fr);
	box-shadow: inset 2px 0 0 transparent;
}
.diff-line-add {
	background: var(--color-diff-add-bg);
	box-shadow: inset 2px 0 0 var(--color-diff-add);
}
.diff-line-del {
	background: var(--color-diff-delete-bg);
	box-shadow: inset 2px 0 0 var(--color-diff-delete);
}
.diff-number {
	padding-right: var(--space-2);
	text-align: right;
	color: var(--color-text-subtle);
}
.diff-gutter {
	color: var(--color-text-subtle);
}
.diff-line-add .diff-gutter {
	color: var(--color-diff-add);
}
.diff-line-del .diff-gutter {
	color: var(--color-diff-delete);
}
.diff-content {
	padding-right: var(--space-3);
	white-space: pre;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--color-diff-text);
}
.comment-card-diff-dim .diff-content {
	color: var(--color-text-subtle);
}

.comment-card-text {
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}

/* Under the replies: the reply field, then the state actions on the same line
   while the field rests, and on their own line once it opens to write. */
.thread-reply-composer {
	box-shadow: inset 0 1px 0 var(--color-border);
}
/* The field keeps room to type in, and the actions wrap under it in a pane too
   narrow for both. */
.thread-reply-composer > :global(.comment-editor) {
	flex: 1 1 calc(40 * var(--u));
}
.thread-reply-composer > :global(.comment-editor-open) {
	flex-basis: 100%;
}

.thread-delete-bar {
	background: var(--color-danger-bg);
	box-shadow: inset 0 1px 0 var(--color-danger-border);
}
</style>
