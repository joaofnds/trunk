<script lang="ts">
// Three ways to start a comment on a diff line, over one mock hunk, so they can
// be tried side by side before one is built into the diff views.
//
// selection: the line numbers select, and one Comment button sits on the last
//   selected line. Nothing shows under the pointer.
// pointer: one "+" follows the pointer, as a single control the list moves from
//   row to row, hidden while a button is held. A press on it drags a range.
// header: the line numbers select, and the hunk header's Comment acts on them.

import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import Plus from "@lucide/svelte/icons/plus";
import type { Attachment } from "svelte/attachments";
import ComposerFrame from "../../components/review/ComposerFrame.svelte";
import { lineBackground } from "../../lib/diff-utils.js";
import { DIFF_ROW_FONT } from "../../lib/row-metrics.js";
import Button from "../../lib/ui/Button.svelte";
import GutterGrip from "../../lib/ui/GutterGrip.svelte";
import Keycap from "../../lib/ui/Keycap.svelte";
import Tab from "../../lib/ui/Tab.svelte";
import TabStrip from "../../lib/ui/TabStrip.svelte";
import { type MockLine, mockLines } from "./mock.js";

type Variant = "selection" | "pointer" | "header";

const VARIANTS: { id: Variant; name: string; how: string }[] = [
	{
		id: "selection",
		name: "A. Comment on the selection",
		how: "Click or drag the line numbers, Shift-click to stretch or shrink. A Comment button sits at the end of the selected lines. Nothing appears under the pointer.",
	},
	{
		id: "pointer",
		name: "B. One + under the pointer",
		how: "One + follows the pointer from line to line. Click it to comment on that line, or press it and drag across lines. It hides while the mouse button is held.",
	},
	{
		id: "header",
		name: "C. Hunk header only",
		how: "Click or drag the line numbers, then use Comment in the hunk header. This is how it worked before the +.",
	},
];

const lines = mockLines();
const first = new URLSearchParams(location.search).get("variant");
let variant = $state<Variant>(
	VARIANTS.find((v) => v.id === first)?.id ?? "selection",
);

let selected = $state(new Set<number>());
let anchor = $state<number | null>(null);
let drag = $state<"grip" | "comment" | null>(null);
let hoverRow = $state<number | null>(null);
let composer = $state<{ from: number; to: number } | null>(null);
let text = $state("");

const selectionEnd = $derived(
	selected.size > 0 && drag === null && composer === null
		? Math.max(...selected)
		: null,
);
const variantInfo = $derived(VARIANTS.find((v) => v.id === variant));

function choose(next: Variant) {
	variant = next;
	reset();
}

function reset() {
	selected = new Set();
	anchor = null;
	drag = null;
	hoverRow = null;
	composer = null;
	text = "";
}

function between(a: number, b: number): Set<number> {
	const range = new Set<number>();
	for (let i = Math.min(a, b); i <= Math.max(a, b); i++) range.add(i);
	return range;
}

function lineNo(line: MockLine): number {
	return line.new ?? line.old ?? 0;
}

function rangeName(from: number, to: number): string {
	const a = lineNo(lines[from]);
	const b = lineNo(lines[to]);
	return a === b ? `line ${a}` : `lines ${a} to ${b}`;
}

function openComposer() {
	if (selected.size === 0) return;
	composer = { from: Math.min(...selected), to: Math.max(...selected) };
}

function pressGrip(i: number, e: MouseEvent) {
	e.preventDefault();
	if (e.shiftKey && anchor !== null) {
		selected = between(anchor, i);
		if (composer) openComposer();
		return;
	}
	anchor = i;
	selected = new Set([i]);
	drag = "grip";
}

function pressPlus(i: number, e: MouseEvent) {
	e.preventDefault();
	e.stopPropagation();
	if (e.shiftKey && composer && anchor !== null) {
		selected = between(anchor, i);
		openComposer();
		return;
	}
	anchor = i;
	selected = new Set([i]);
	composer = null;
	drag = "comment";
	hoverRow = null;
}

function release() {
	if (drag === "comment") openComposer();
	drag = null;
}

function rowAt(e: PointerEvent): number | null {
	const row = (e.target as Element | null)?.closest<HTMLElement>("[data-row]");
	return row ? Number(row.dataset.row) : null;
}

// The list tracks the pointer itself, so there is one hovered row whatever the
// engine thinks is hovered, and a held button hides the + until it is released.
const tracksPointer: Attachment<HTMLElement> = (node) => {
	const move = (e: PointerEvent) => {
		const i = rowAt(e);
		if (drag !== null && i !== null && anchor !== null) {
			selected = between(anchor, i);
		}
		hoverRow = e.buttons === 0 && drag === null ? i : null;
	};
	const leave = () => {
		hoverRow = null;
	};
	node.addEventListener("pointermove", move);
	node.addEventListener("pointerleave", leave);
	return () => {
		node.removeEventListener("pointermove", move);
		node.removeEventListener("pointerleave", leave);
	};
};
</script>

<svelte:window
	onmouseup={release}
	onkeydown={(e) => {
		if (e.key === "Escape" && composer === null) reset();
		if (
			e.key === "c" &&
			variant === "selection" &&
			composer === null &&
			selected.size > 0 &&
			!(e.target instanceof HTMLTextAreaElement)
		) {
			e.preventDefault();
			openComposer();
		}
	}}
/>

{#snippet heading()}
	<MessageSquarePlus size={14} aria-hidden="true" />
	{#if composer}
		Comment on {rangeName(composer.from, composer.to)}
	{/if}
{/snippet}

<div class="flex h-screen flex-col bg-bg text-text">
	<TabStrip aria-label="Prototype variant">
		{#each VARIANTS as v (v.id)}
			<Tab selected={variant === v.id} onclick={() => choose(v.id)}
				>{v.name}</Tab
			>
		{/each}
	</TabStrip>

	<p
		class="bg-surface-raised px-4 py-2 text-callout text-text-muted shadow-hairline"
	>
		{variantInfo?.how}
	</p>

	<div class="proto-diff min-h-0 flex-1 overflow-auto" {@attach tracksPointer}>
		<div class="hunk-toolbar">
			<span class="hunk-header-text"
				>@@ -40,25 +40,31 @@ export function parseRange</span
			>
			{#if variant === "header"}
				<Button
					size="xs"
					variant={selected.size > 0 ? "primary" : "secondary"}
					onclick={() => {
						if (selected.size === 0) selected = between(0, lines.length - 1);
						openComposer();
					}}
					>{selected.size > 0
						? `Comment (${selected.size})`
						: "Comment on hunk"}</Button
				>
			{/if}
			<Button size="xs">Stage hunk</Button>
			<Button size="xs">Discard hunk</Button>
		</div>

		{#each lines as line, i (i)}
			<div
				class="diff-line flex items-start px-2 text-diff-text whitespace-pre {line.origin ===
				"Add"
					? "diff-line-add"
					: line.origin === "Delete"
						? "diff-line-delete"
						: ""}"
				class:in-selection={selected.has(i)}
				class:selection-first={selected.has(i) && !selected.has(i - 1)}
				class:selection-last={selected.has(i) && !selected.has(i + 1)}
				class:holds-action={variant === "selection" && selectionEnd === i}
				style:font-family={DIFF_ROW_FONT.fontFamily}
				style:font-size={DIFF_ROW_FONT.fontSize}
				style:line-height={DIFF_ROW_FONT.lineHeight}
				style:background={lineBackground(line.origin, false)}
				data-row={i}
			>
				<span class="marker-cell"
					>{#if variant === "pointer" && hoverRow === i}
						<Button
							icon
							size="xs"
							variant="primary"
							aria-label="Comment on line {lineNo(line)}"
							tabindex={-1}
							onmousedown={(e) => pressPlus(i, e)}
							><Plus size={10} aria-hidden="true" /></Button
						>
					{/if}</span
				><GutterGrip
					aria-label="Select line {lineNo(line)}"
					onmousedown={(e) => pressGrip(i, e)}
					><span class="gutter-num">{line.old ?? ""}</span
					><span class="gutter-num">{line.new ?? ""}</span></GutterGrip
				><span class="flex-1 select-text cursor-text">{line.text}</span>
				{#if variant === "selection" && selectionEnd === i}
					<span class="selection-action"
						><Button
							size="sm"
							variant="ghost"
							aria-keyshortcuts="C"
							onclick={openComposer}
							><MessageSquarePlus size={13} aria-hidden="true" />Comment<Keycap
								>C</Keycap
							></Button
						></span
					>
				{/if}
			</div>
			{#if composer && composer.to === i}
				<div class="composer-row">
					<ComposerFrame
						{heading}
						activeReview={{ id: "R-12", title: "Range parsing" }}
						activeReviewId="R-12"
						placeholder="Leave a comment"
						bind:text
						busy={false}
						submitLabel="Comment"
						submitDisabled={text.trim() === ""}
						onsubmit={reset}
						oncancel={reset}
						onescape={reset}
						extendHint={variant !== "pointer"}
					/>
				</div>
			{/if}
		{/each}
	</div>
</div>

<style>
.proto-diff {
	background: var(--color-surface);
}
.hunk-toolbar {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-1) var(--space-2);
	background: color-mix(
		in oklch,
		var(--color-info) 6%,
		var(--color-surface-raised)
	);
	box-shadow: inset 0 -1px 0 var(--color-border);
}
.hunk-header-text {
	flex: 1;
	color: color-mix(in oklch, var(--color-info) 70%, var(--color-text-subtle));
	font-size: var(--text-small);
	font-family: var(--font-mono);
}
.diff-line {
	position: relative;
	isolation: isolate;
	border-left: 3px solid var(--color-border);
}
.diff-line-add {
	border-left-color: var(--color-diff-add);
}
.diff-line-delete {
	border-left-color: var(--color-diff-delete);
}
.diff-line:has(:global([data-gutter-grip]:hover))::after {
	content: "";
	position: absolute;
	inset: 0;
	z-index: -1;
	background: color-mix(in oklch, var(--color-hover) 60%, transparent);
	pointer-events: none;
}
.marker-cell {
	display: inline-flex;
	flex-shrink: 0;
	align-self: stretch;
	align-items: center;
	min-width: calc(5 * var(--u));
	user-select: none;
}
.gutter-num {
	min-width: calc(9 * var(--u));
	text-align: right;
	color: var(--color-text-muted);
	padding-right: var(--space-2);
}
/* The selection is one tint and one hairline around the block, both in the
   accent, laid over the diff's own colors so an added or removed line still
   reads as one. */
.in-selection::before {
	content: "";
	position: absolute;
	inset: 0;
	z-index: -1;
	background: var(--color-accent-bg);
	box-shadow:
		inset 1px 0 0 var(--color-accent-border),
		inset -1px 0 0 var(--color-accent-border);
	pointer-events: none;
}
.selection-first::before {
	box-shadow:
		inset 1px 0 0 var(--color-accent-border),
		inset -1px 0 0 var(--color-accent-border),
		inset 0 1px 0 var(--color-accent-border);
}
.selection-last::before {
	box-shadow:
		inset 1px 0 0 var(--color-accent-border),
		inset -1px 0 0 var(--color-accent-border),
		inset 0 -1px 0 var(--color-accent-border);
}
.selection-first.selection-last::before {
	box-shadow: inset 0 0 0 1px var(--color-accent-border);
}
/* The line that carries the action paints over the line under it, which the
   action straddles. */
.holds-action {
	z-index: 1;
}
/* A quiet control on the selection's bottom edge, at its right, where it
   covers the end of a line rather than its code. It appears at once: it shows
   on every selection, and a fade there would only slow the hand down. */
.selection-action {
	position: absolute;
	right: var(--space-4);
	bottom: 0;
	transform: translateY(50%);
	display: inline-flex;
	border-radius: var(--radius);
	background: var(--color-surface-raised);
	border: 1px solid var(--color-border);
	box-shadow: var(--shadow-md);
	font-family: var(--font-sans);
	user-select: none;
}
.composer-row {
	display: flex;
	padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
}
</style>
