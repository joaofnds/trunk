<script lang="ts">
import { type Snippet, tick } from "svelte";
import { reportErrorToast } from "../../lib/error-report.js";
import { externalLinks } from "../../lib/external-links.js";
import { safeInvoke } from "../../lib/invoke.js";
import {
	continueList,
	type FieldState,
	linkSelection,
	pasteAsLink,
	prefixLines,
	type TextEdit,
	wrapSelection,
} from "../../lib/markdown-editing.js";
import Button from "../../lib/ui/Button.svelte";
import Keycap from "../../lib/ui/Keycap.svelte";

interface Props {
	text: string;
	/** The field's accessible name. */
	label: string;
	placeholder: string;
	submitLabel: string;
	submitDisabled: boolean;
	busy?: boolean;
	onsubmit: () => void;
	oncancel: () => void;
	oninput?: () => void;
	/** What Escape does in the text; without it Escape lets go of the focus. */
	onescape?: () => void;
	/** `framed` draws its own box, `flush` lies inside a card that frames it,
	 *  and `fill` lies inside one of fixed height, the text taking the slack. */
	variant?: "framed" | "flush" | "fill";
	/** Rest on one line with no actions until it is clicked or holds text, as a
	 *  thread's reply does, rather than opening focused. */
	collapsible?: boolean;
	/** Hints laid before the submit hint. */
	hint?: Snippet;
}

let {
	text = $bindable(),
	label,
	placeholder,
	submitLabel,
	submitDisabled,
	busy = false,
	onsubmit,
	oncancel,
	oninput,
	onescape,
	variant = "framed",
	collapsible = false,
	hint,
}: Props = $props();

let field = $state<HTMLTextAreaElement | null>(null);
let focused = $state(false);
const open = $derived(!collapsible || focused || text !== "");
let previewing = $state(false);
let previewHtml = $state<string | null>(null);

// An editor that opens does so to be typed in, so it takes the focus at once.
$effect(() => {
	if (!collapsible) field?.focus();
});

function fieldState(node: HTMLTextAreaElement): FieldState {
	return {
		value: node.value,
		selectionStart: node.selectionStart,
		selectionEnd: node.selectionEnd,
	};
}

// Inserting through the editing command keeps the edit on the field's undo
// stack. Where the engine has no such command the text is set directly.
function apply(node: HTMLTextAreaElement, edit: TextEdit) {
	node.setSelectionRange(edit.start, edit.end);
	const inserted =
		edit.text === ""
			? document.execCommand?.("delete")
			: document.execCommand?.("insertText", false, edit.text);
	if (!inserted) {
		node.setRangeText(edit.text, edit.start, edit.end);
		node.dispatchEvent(new Event("input", { bubbles: true }));
	}
	node.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

// The preview is the backend's render of the text, the same one a submitted
// comment's card shows, so the two cannot disagree.
async function togglePreview() {
	if (previewing) {
		previewing = false;
		previewHtml = null;
		await tick();
		field?.focus();
		return;
	}

	previewing = true;
	if (text.trim() === "") return;
	try {
		const html = await safeInvoke<string>("render_comment_preview", { text });
		if (previewing) previewHtml = html;
	} catch (error) {
		reportErrorToast(error, "Preview failed");
		previewing = false;
	}
}

function shortcutEdit(
	event: KeyboardEvent,
	state: FieldState,
): TextEdit | null {
	if (event.shiftKey) {
		if (event.code === "Digit7") return prefixLines(state, "1. ");
		if (event.code === "Digit8") return prefixLines(state, "- ");
		if (event.code === "Period") return prefixLines(state, "> ");
		return null;
	}
	switch (event.key.toLowerCase()) {
		case "b":
			return wrapSelection(state, "**");
		case "i":
			return wrapSelection(state, "_");
		case "e":
			return wrapSelection(state, "`");
		case "k":
			return linkSelection(state);
		default:
			return null;
	}
}

function onkeydown(event: KeyboardEvent) {
	if (event.isComposing) return;
	const node = event.currentTarget as HTMLTextAreaElement;
	const command = event.metaKey || event.ctrlKey;

	if (event.key === "Escape") {
		event.preventDefault();
		if (onescape) onescape();
		else node.blur();
		return;
	}

	if (event.key === "Enter" && command) {
		event.preventDefault();
		if (!submitDisabled) onsubmit();
		return;
	}

	if (event.key === "Enter") {
		if (event.shiftKey || event.altKey) return;
		const edit = continueList(fieldState(node));
		if (!edit) return;
		event.preventDefault();
		apply(node, edit);
		return;
	}

	if (!command || event.altKey) return;
	if (event.shiftKey && event.code === "KeyP") {
		event.preventDefault();
		event.stopPropagation();
		void togglePreview();
		return;
	}

	const edit = shortcutEdit(event, fieldState(node));
	if (!edit) return;
	event.preventDefault();
	event.stopPropagation();
	apply(node, edit);
}

function onfocusout(event: FocusEvent) {
	const root = event.currentTarget as HTMLElement;
	if (!root.contains(event.relatedTarget as Node | null)) focused = false;
}

function onpaste(event: ClipboardEvent) {
	const node = event.currentTarget as HTMLTextAreaElement;
	const pasted = event.clipboardData?.getData("text/plain") ?? "";
	const edit = pasteAsLink(fieldState(node), pasted);
	if (!edit) return;
	event.preventDefault();
	apply(node, edit);
}
</script>

<!--
	The one place a review comment is written: a new comment, a reply, and the
	edit of either. Enter starts a new line, and a list goes on to its next item;
	Cmd+Enter submits; Cmd+B, I, E and K write bold, italic, code and a link;
	Cmd+Shift+P shows the comment as it will render, as GitHub's comment box does.
-->
<div
	class="comment-editor comment-editor-{variant}"
	class:comment-editor-open={open}
	onfocusin={() => (focused = true)}
	{onfocusout}
>
	{#if previewing}
		<div
			class="comment-editor-preview markdown-body select-text"
			use:externalLinks
		>
			{#if text.trim() === ""}
				<p class="text-text-subtle">Nothing to preview</p>
			{:else if previewHtml !== null}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- backend-sanitized
				     (comrak unsafe-off + ammonia); see commands/markdown.rs -->
				{@html previewHtml}
			{/if}
		</div>
	{/if}
	<div class="comment-editor-grow" data-value={text} hidden={previewing}>
		<textarea
			bind:this={field}
			bind:value={text}
			aria-label={label}
			{placeholder}
			disabled={busy}
			rows="1"
			{oninput}
			{onkeydown}
			{onpaste}
		></textarea>
	</div>
	{#if open}
		<footer class="comment-editor-actions">
			<span class="comment-editor-hint"
				>{#if hint}
					{@render hint()}
				{/if}<Keycap>⌘</Keycap><Keycap>↵</Keycap>
				to {submitLabel.toLowerCase()}</span
			>
			<span class="ml-auto flex items-center gap-2">
				<Button size="sm" variant="ghost" onclick={() => void togglePreview()}
					>{previewing ? "Write" : "Preview"}</Button
				>
				<Button size="sm" variant="ghost" disabled={busy} onclick={oncancel}
					>Cancel</Button
				>
				<Button
					size="sm"
					variant="primary"
					data-testid="comment-submit"
					disabled={submitDisabled}
					onclick={onsubmit}
					>{submitLabel}</Button
				>
			</span>
		</footer>
	{/if}
</div>

<style>
.comment-editor {
	display: flex;
	flex-direction: column;
	min-width: 0;
	background: var(--color-bg);
}

.comment-editor-framed {
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	overflow: hidden;
}

.comment-editor-fill {
	flex: 1 1 0;
	min-height: 0;
}

/* The field grows with its text: a hidden copy of the text shares the field's
   grid cell and type, so the cell is as tall as the text, up to a cap past
   which the field scrolls. */
.comment-editor-grow {
	display: grid;
}

.comment-editor-grow[hidden] {
	display: none;
}

.comment-editor-preview {
	box-sizing: border-box;
	min-height: calc(20 * var(--u));
	max-height: calc(75 * var(--u));
	overflow-y: auto;
	padding: var(--space-2) var(--space-3);
	color: var(--color-text);
	font-size: var(--text-callout);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}

.comment-editor-fill .comment-editor-preview {
	flex: 1 1 0;
	min-height: 0;
	max-height: none;
}

.comment-editor-grow::after {
	content: attr(data-value) " ";
	visibility: hidden;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	overflow: hidden;
}

.comment-editor-grow > textarea,
.comment-editor-grow::after {
	grid-area: 1 / 1;
	box-sizing: border-box;
	min-height: calc(20 * var(--u));
	max-height: calc(75 * var(--u));
	padding: var(--space-2) var(--space-3);
	border: none;
	font-family: var(--font-sans);
	font-size: var(--text-callout);
	line-height: var(--leading-normal);
}

.comment-editor-grow > textarea {
	resize: none;
	overflow-y: auto;
	color: var(--color-text-strong);
	background: var(--color-bg);
}

.comment-editor-grow > textarea::placeholder {
	color: var(--color-text-subtle);
}

/* The caret shows where the typing goes, so the field draws no ring. */
.comment-editor-grow > textarea:focus {
	outline: none;
}

.comment-editor-fill .comment-editor-grow {
	flex: 1 1 0;
	min-height: 0;
}

.comment-editor-fill .comment-editor-grow::after {
	display: none;
}

.comment-editor-fill .comment-editor-grow > textarea {
	height: 100%;
	min-height: 0;
	max-height: none;
}

.comment-editor-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
	border-top: 1px solid var(--color-border);
}

.comment-editor-hint {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	color: var(--color-text-subtle);
	font-size: var(--text-small);
}

/* A collapsible editor at rest is one line, and opens to the full editor once
   it holds the focus or any text. */
.comment-editor:not(.comment-editor-open) .comment-editor-grow > textarea,
.comment-editor:not(.comment-editor-open) .comment-editor-grow::after {
	min-height: 0;
	padding-block: var(--space-1);
}
</style>
