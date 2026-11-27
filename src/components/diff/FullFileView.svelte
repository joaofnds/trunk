<script lang="ts">
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import type { DiffMatch } from "../../lib/diff-find.js";
import {
	buildInlineRows,
	countLines,
	type DiffComposer,
	type DiffRow,
	FIXED_ROW_HEIGHT_VARS,
} from "../../lib/diff-rows.js";
import { gripLabel, lineBackground } from "../../lib/diff-utils.js";
import { focusInEditable, keyChord } from "../../lib/keyboard.js";
import { measure } from "../../lib/perf.js";
import type { ThreadEditorSession } from "../../lib/review-editors.svelte.js";
import { FLASH_DURATION } from "../../lib/row-flash.svelte.js";
import { DIFF_ROW_FONT } from "../../lib/row-metrics.js";
import type { ThreadFolds } from "../../lib/thread-folds.svelte.js";
import type {
	DiffLine,
	FileDiff,
	ReviewFilter,
	Thread,
} from "../../lib/types.js";
import GutterGrip from "../../lib/ui/GutterGrip.svelte";
import {
	createVirtualizedDiff,
	type DiffListHandle,
	type ReadingAnchor,
	TAB_SIZE,
} from "../../lib/virtualized-diff.svelte.js";
import { diffLineText } from "./DiffLineText.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";
import InlineThread from "./InlineThread.svelte";
import SelectionComment, {
	SELECTION_COMMENT_CLEARANCE,
} from "./SelectionComment.svelte";
import ThreadMarker from "./ThreadMarker.svelte";

interface Props {
	activeMatch?: DiffMatch | null;
	fileDiffs: FileDiff[];
	showInvisibles: boolean;
	wordWrap: boolean;
	repoPath: string;
	diffKind: PanelDiffKind;
	/** Whether this view's keys act: false while its tab is behind another or
	 *  the rebase editor covers it, since its listener is on the window. */
	keysActive: boolean;
	// Bubbles the chosen file path + the flat selected indices (into the file's
	// hunks.flatMap(h => h.lines)) up to the DiffPanel host when the user clicks
	// the Comment affordance.
	oncommentfullfile: (filePath: string, selectedIndices: Set<number>) => void;
	/** A shift-click stretched the selection to these lines, which the comment
	 *  being written follows. */
	onextendcomment?: (filePath: string, selectedIndices: Set<number>) => void;
	takesComments: boolean;
	reviewFilter: ReviewFilter;
	viewComments?: Thread[];
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	/** The open comment composer, drawn under the line its comment ends on. */
	composer?: DiffComposer | null;
	/** Where the viewport opens after a subject or mode change. */
	startAt?: ReadingAnchor | null;
	/** Which threads are folded, shared with the views the diff switches to. */
	folds: ThreadFolds;
}

let {
	activeMatch = null,
	fileDiffs,
	showInvisibles,
	wordWrap,
	repoPath = "",
	diffKind,
	keysActive,
	oncommentfullfile,
	onextendcomment,
	takesComments,
	reviewFilter,
	viewComments = [],
	editorSessionForThread,
	composer = null,
	startAt = null,
	folds,
}: Props = $props();

// Net-new contiguous selection state (D-01): a click sets a single-line anchor;
// shift-click extends the focus, and the selected span is the inclusive range
// anchorIndex..focusIndex over the active file's flat line list. Only new-side
// lines (new_lineno != null) are valid endpoints (D-02). Scoped to one file at a
// time via selectedPath.
let selectedPath = $state<string | null>(null);
let anchorIndex = $state<number | null>(null);
let focusIndex = $state<number | null>(null);

let list = $state<DiffListHandle | null>(null);

// Reactive, so the selection's Comment action stays out of the way of the
// press that is still making the selection.
let pressHeld = $state(false);

// The contiguous span as flat indices into the active file's line list.
const selectedIndices = $derived(computeSpan(anchorIndex, focusIndex));

const model = $derived(
	measure("diff.buildRows", (observation) => {
		observation.attr("lines", countLines(fileDiffs));

		return buildInlineRows(fileDiffs, {
			content: "full",
			comments: viewComments,
			reviewFilter,
			collapsed: new Set<string>(),
			fileHeaders: false,
			tabSize: TAB_SIZE,
			invisibles: showInvisibles,
			composer: composer?.place,
		});
	}),
);

// A file shown whole holds no change, so its old and new numbers agree and one
// column of them says it all.
const showsWholeFile = $derived(diffKind === "current_file");

const vd = createVirtualizedDiff({
	layout: "inline",
	model: () => model,
	wordWrap: () => wordWrap,
	composer: () => composer?.place,
	list: () => list,
	startAt: () => startAt,
	content: () => "full",
	numberColumns: () => (showsWholeFile ? 1 : 2),
});

// An allowlist, not a denylist: a diff kind the store cannot anchor a thread
// against must not gain the affordance by being forgotten here.
const kindTakesComments = $derived(
	diffKind === "commit" ||
		diffKind === "unstaged" ||
		diffKind === "current_file",
);
// Whether a line can take a new comment here, as the Comment action can.
const commentable = $derived(takesComments && kindTakesComments);

function inSelection(path: string, index: number): boolean {
	return selectedPath === path && selectedIndices.has(index);
}

// The line the selection's Comment action sits on, its last, once the press
// that made it is released and while no composer is open.
const actionIndex = $derived(
	commentable && composer === null && !pressHeld && selectedIndices.size > 0
		? Math.max(...selectedIndices)
		: null,
);

function commentOnSelection() {
	if (selectedPath !== null) oncommentfullfile(selectedPath, selectedIndices);
}

$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		if (!keysActive || focusInEditable(document.activeElement)) return;
		if (keyChord(e) !== "c" || actionIndex === null) return;

		e.preventDefault();
		commentOnSelection();
	}
	window.addEventListener("keydown", handleKeydown);
	window.addEventListener("mouseup", stopDrag);
	return () => {
		window.removeEventListener("keydown", handleKeydown);
		window.removeEventListener("mouseup", stopDrag);
		stopDrag();
	};
});

function computeSpan(anchor: number | null, focus: number | null): Set<number> {
	if (anchor === null || focus === null) return new Set();
	const start = Math.min(anchor, focus);
	const end = Math.max(anchor, focus);
	const span = new Set<number>();
	for (let i = start; i <= end; i++) span.add(i);
	return span;
}

function selectLine(
	path: string,
	line: DiffLine,
	index: number,
	shift: boolean,
) {
	// D-02: only new-side lines are valid selection endpoints. A click on a Delete
	// line (new_lineno === null) is a no-op.
	if (line.new_lineno === null) return;

	if (shift && selectedPath === path && anchorIndex !== null) {
		focusIndex = index;
		onextendcomment?.(path, computeSpan(anchorIndex, index));
		return;
	}

	selectedPath = path;
	anchorIndex = index;
	focusIndex = index;
}

// A press arms the span and holds it open; the pointer crossing another row
// carries the focus with it, followed by a document listener that lives only as
// long as the drag. Not a second selection model — a drag is the contiguous span
// with a moving endpoint, which is what shift-click already is.
function startDrag(path: string, line: DiffLine, index: number, e: MouseEvent) {
	// Suppress the webview's own text selection for the whole gesture: a drag
	// crosses gutters and code spans that are otherwise user-selectable, and
	// without this the browser paints its selection over ours.
	e.preventDefault();
	document.getSelection()?.removeAllRanges();
	pressHeld = true;

	selectLine(path, line, index, e.shiftKey);
	document.addEventListener("mouseover", extendDrag);
}

function stopDrag() {
	pressHeld = false;
	document.removeEventListener("mouseover", extendDrag);
}

// The pointer moved onto another element during a drag. A row it crosses with
// no button held ends the drag: there is no gesture left to continue.
function extendDrag(e: MouseEvent) {
	if (!(e.target instanceof Element)) return;

	const row = e.target.closest("[data-flat-index]");
	if (!(row instanceof HTMLElement)) return;

	if (e.buttons !== 1) {
		stopDrag();
		return;
	}

	// D-02 again: a Delete line is not a valid endpoint, so the span stops at
	// the last new-side row the pointer crossed rather than snapping to it.
	const { linePath, newSide } = row.dataset;
	const index = Number(row.dataset.flatIndex);
	if (linePath !== selectedPath || newSide === undefined) return;

	focusIndex = index;
}

export const searchRows = vd.searchRows;
export const revealSearchRow = vd.revealSearchRow;
export const readingLine = vd.readingLine;
export const readingThread = vd.readingThread;
export const isReady = vd.isReady;
export const ordinalOf = vd.ordinalOf;
export const scrollToHunk = vd.scrollToHunk;
export const scrollToLine = vd.scrollToLine;
export const scrollToThread = vd.scrollToThread;
export const step = vd.step;

export function hasSelection(): boolean {
	return anchorIndex !== null;
}

// Called by the DiffPanel host (via bind:this) on mode/layout toggle and Escape
// so the selection never goes stale.
export function clearSelection() {
	stopDrag();
	selectedPath = null;
	anchorIndex = null;
	focusIndex = null;
}
</script>

{#snippet threadCard(c: Thread)}
	<InlineThread
		virtualized
		thread={c}
		{repoPath}
		{folds}
		{editorSessionForThread}
	/>
{/snippet}

{#snippet lineNumbers(line: DiffLine)}
	{#if !showsWholeFile}
		<span class="gutter-num" style:min-width={vd.gutterW}
			>{line.old_lineno ?? ""}</span
		>
	{/if}<span class="gutter-num" style:min-width={vd.gutterW}
		>{line.new_lineno ?? ""}</span
	>
{/snippet}

{#snippet diffRow(item: DiffRow, index: number)}
	{#if item.kind === "line"}
		{@const line = item.line}
		{@const isSelectable = line.new_lineno !== null}
		{@const isSelected = inSelection(item.path, item.flatIdx)}
		{@const holdsAction =
			selectedPath === item.path && actionIndex === item.flatIdx}
		<div
			class="diff-line flex items-start px-2 text-diff-text {line.origin ===
			"Add"
				? "diff-line-add"
				: line.origin === "Delete"
					? "diff-line-delete"
					: "diff-line-context"}"
			class:whitespace-pre-wrap={vd.wrapActive}
			class:whitespace-pre={!vd.wrapActive}
			class:break-all={vd.wrapActive}
			class:break-normal={!vd.wrapActive}
			class:in-selection={isSelected}
			class:selection-first={isSelected &&
				!inSelection(item.path, item.flatIdx - 1)}
			class:selection-last={isSelected &&
				!inSelection(item.path, item.flatIdx + 1)}
			class:holds-action={holdsAction}
			class:run-flash={vd.flashLit(index)}
			style:font-family={DIFF_ROW_FONT.fontFamily}
			style:font-size={DIFF_ROW_FONT.fontSize}
			style:line-height={DIFF_ROW_FONT.lineHeight}
			style:background={lineBackground(line.origin)}
			data-line-path={item.path}
			data-flat-index={item.flatIdx}
			data-new-side={isSelectable ? "" : undefined}
			><ThreadMarker marker={item.marker} width={vd.markerW} />
			{#if isSelectable}
				<GutterGrip
					aria-label={gripLabel(line)}
					onmousedown={(e) => startDrag(item.path, line, item.flatIdx, e)}
					onclick={(e) => selectLine(item.path, line, item.flatIdx, e.shiftKey)}
					>{@render lineNumbers(line)}</GutterGrip
				>
			{:else}
				<span class="inline-flex shrink-0 select-none"
					>{@render lineNumbers(line)}</span
				>
			{/if}<span
				class="diff-line-content select-text cursor-text"
				data-code-line
				>{@render diffLineText(
					line,
					showInvisibles,
					activeMatch?.row === index ? activeMatch : null,
				)}</span
			>{#if holdsAction}
				<SelectionComment oncomment={commentOnSelection} />
			{/if}</div
		>
	{:else if item.kind === "comment"}
		{#each item.threads as c (c.id)}
			<div class="comment-row pan-pinned">{@render threadCard(c)}</div>
		{/each}
	{:else if item.kind === "composer" && composer}
		<div class="composer-row pan-pinned">{@render composer.card()}</div>
	{:else if item.kind === "binary"}
		<div class="binary-row">{item.text}</div>
	{/if}
{/snippet}

<div
	class="full-file"
	style:--diff-flash-duration={FLASH_DURATION}
	style:--diff-file-header-height={FIXED_ROW_HEIGHT_VARS[
		"--diff-file-header-height"
	]}
	style:--diff-hunk-header-height={FIXED_ROW_HEIGHT_VARS[
		"--diff-hunk-header-height"
	]}
	style:--diff-binary-row-height={FIXED_ROW_HEIGHT_VARS[
		"--diff-binary-row-height"
	]}
	style:--diff-composer-row-height={FIXED_ROW_HEIGHT_VARS[
		"--diff-composer-row-height"
	]}
>
	<div class="list-area" data-code-selection bind:this={vd.pane}>
		{#if vd.ready}
			<ExactVirtualList
				bind:this={list}
				items={model.rows}
				heights={vd.heights}
				contentWidth={vd.contentWidth}
				trailingSpace={SELECTION_COMMENT_CLEARANCE}
				renderItem={diffRow}
			/>
		{/if}

		<div
			class="diff-line metrics-probe"
			bind:this={vd.metricsProbe}
			style:font-family={DIFF_ROW_FONT.fontFamily}
			style:font-size={DIFF_ROW_FONT.fontSize}
			style:line-height={DIFF_ROW_FONT.lineHeight}
		></div>
	</div>
</div>

<style>
/* Over the row's own background, which an inline style sets per line. */
.run-flash {
	animation: run-flash var(--diff-flash-duration) ease-out;
}
/* Under reduced motion the flash holds its colour and clears at once, so the
   place a jump landed is still marked. */
@media (prefers-reduced-motion: reduce) {
	.run-flash {
		animation-timing-function: step-end;
	}
}
/* An inset spread fills a box whose shorter side is under twice it, and a row is one line. */
@keyframes run-flash {
	0% {
		box-shadow: inset 0 0 0 64px var(--color-hunk-flash);
	}
	100% {
		box-shadow: inset 0 0 0 64px transparent;
	}
}
.full-file {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	min-height: 0;
}
.list-area {
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
}

.metrics-probe {
	position: absolute;
	top: 0;
	left: 0;
	visibility: hidden;
	pointer-events: none;
	z-index: -1;
}
.binary-row {
	height: var(--diff-binary-row-height);
	box-sizing: border-box;
	padding: var(--space-2);
	color: var(--color-text-muted);
	font-size: var(--text-callout);
	line-height: var(--text-callout--line-height);
}

/* Change-indicator accent bar: saturated for add/delete, neutral rail for context.
     Every line carries the 3px border so columns stay aligned regardless of origin. */
.diff-line {
	position: relative;
	/* Own stacking context so the z-index:-1 hover overlay below resolves
       against this row (painting over its inline background) instead of slipping
       behind it. */
	isolation: isolate;
	border-left: 3px solid var(--color-border);
}
.diff-line-add {
	border-left-color: var(--color-diff-add);
}

.gutter-num {
	text-align: right;
	color: var(--color-text-muted);
	padding-right: var(--space-2);
}

/* Faint full-row tint while hovering a selectable gutter — signals the line
     number arms selection, not the code. z-index:-1 overlay so it tints over the
     inline diff background without hiding it. */
.diff-line:has(:global([data-gutter-grip]:hover))::after {
	content: "";
	position: absolute;
	inset: 0;
	z-index: -1;
	background: color-mix(in oklch, var(--color-hover) 60%, transparent);
	pointer-events: none;
}
.diff-line-delete {
	border-left-color: var(--color-diff-delete);
}
/* Pinned against the pan: one viewport wide and held at the scrollport's left
   edge, so a wide file scrolling sideways leaves it where it is. */
.pan-pinned {
	position: sticky;
	left: 0;
	width: 100cqi;
}

/* The comment and composer share their inset from the change-indicator rail. */
.comment-row {
	padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
	width: 100cqi;
	box-sizing: border-box;
}

/* The composer row holds its declared height, and the card fills it, so the
   height the row model counts is the height drawn. */
.composer-row {
	display: flex;
	height: var(--diff-composer-row-height);
	padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
	box-sizing: border-box;
}
</style>
