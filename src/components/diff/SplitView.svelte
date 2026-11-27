<script lang="ts">
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import type { DiffMatch } from "../../lib/diff-find.js";
import {
	buildSplitRows,
	countLines,
	type DiffComposer,
	type DiffRow,
	FIXED_ROW_HEIGHT_VARS,
	type LineMarker,
} from "../../lib/diff-rows.js";
import {
	gripLabel,
	lineBackground,
	type PairedRow,
	splitSide,
	takesNewComment,
} from "../../lib/diff-utils.js";
import { measure } from "../../lib/perf.js";
import type { ThreadEditorSession } from "../../lib/review-editors.svelte.js";
import { FLASH_DURATION } from "../../lib/row-flash.svelte.js";
import { DIFF_ROW_FONT } from "../../lib/row-metrics.js";
import type { ThreadFolds } from "../../lib/thread-folds.svelte.js";
import type {
	ContentMode,
	DiffLine,
	FileDiff,
	ReviewFilter,
	Side,
	Thread,
} from "../../lib/types.js";
import GutterGrip from "../../lib/ui/GutterGrip.svelte";
import {
	createVirtualizedDiff,
	type DiffListHandle,
	type ReadingAnchor,
	TAB_SIZE,
} from "../../lib/virtualized-diff.svelte.js";
import DiffFileHeader from "./DiffFileHeader.svelte";
import { diffLineText } from "./DiffLineText.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";
import HunkActions from "./HunkActions.svelte";
import InlineThread from "./InlineThread.svelte";
import SelectionComment, {
	SELECTION_COMMENT_CLEARANCE,
	type SelectionCommentPlace,
} from "./SelectionComment.svelte";
import ThreadMarker from "./ThreadMarker.svelte";

interface Props {
	activeMatch?: DiffMatch | null;
	contentMode: ContentMode;
	fileDiffs: FileDiff[];
	selectedPath: string | null;
	diffKind: PanelDiffKind;
	hunkOperationInFlight: boolean;
	showInvisibles: boolean;
	wordWrap: boolean;
	selectedHunkKey: string | null;
	selectedLineIndices: Set<number>;
	selectedCount: number;
	selectedChangeCount: number;
	reviewFilter: ReviewFilter;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	/** The open comment composer, drawn under the line its comment ends on. */
	composer?: DiffComposer | null;
	/** Where the viewport opens after a subject or mode change. */
	startAt?: ReadingAnchor | null;
	/** Which threads are folded, shared with the views the diff switches to. */
	folds: ThreadFolds;
	/** Where the selection's Comment action sits, or null while it shows none. */
	selectionComment: SelectionCommentPlace | null;
	oncommentselection: () => void;
	isMerge: boolean;
	collapsedFiles: Set<string>;
	onfilecollapsetoggle: (path: string) => void;
	onlineclick: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
		hunkLines: DiffLine[],
		e: MouseEvent,
	) => void;
	onlinemousedown: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
		hunkLines: DiffLine[],
		e: MouseEvent,
	) => void;
	onstagehunk: (filePath: string, hunkIndex: number) => void;
	onunstagehunk: (filePath: string, hunkIndex: number) => void;
	ondiscardhunk: (filePath: string, hunkIndex: number) => void;
	onstagelines: (filePath: string, hunkIndex: number) => void;
	onunstagelines: (filePath: string, hunkIndex: number) => void;
	ondiscardlines: (filePath: string, hunkIndex: number) => void;
	oncommentlines: (filePath: string, hunkIndex: number) => void;
	oncommenthunk: (filePath: string, hunkIndex: number) => void;
	repoPath?: string;
	takesComments: boolean;
	viewComments?: Thread[];
}

let {
	activeMatch = null,
	contentMode,
	fileDiffs,
	selectedPath,
	diffKind,
	hunkOperationInFlight,
	showInvisibles,
	wordWrap,
	selectedHunkKey,
	selectedLineIndices,
	selectedCount,
	selectedChangeCount,
	isMerge,
	collapsedFiles,
	onfilecollapsetoggle,
	onlineclick,
	onlinemousedown,
	onstagehunk,
	onunstagehunk,
	ondiscardhunk,
	onstagelines,
	onunstagelines,
	ondiscardlines,
	oncommentlines,
	oncommenthunk,
	repoPath = "",
	takesComments,
	reviewFilter,
	viewComments = [],
	editorSessionForThread,
	composer = null,
	startAt = null,
	folds,
	selectionComment,
	oncommentselection,
}: Props = $props();

// Whether a line can take a new comment here, as the hunk's Comment action can.
const commentable = $derived(takesComments && !isMerge);

function selectable(line: DiffLine): boolean {
	return (
		line.origin !== "Context" ||
		(commentable && takesNewComment(diffKind, line))
	);
}

function inSelection(hunkKey: string, lineIdx: number): boolean {
	return selectedHunkKey === hunkKey && selectedLineIndices.has(lineIdx);
}

// The side of a pair row the selection's Comment action sits on, the side its
// last line belongs to, or null when the row does not hold it.
function actionSide(hunkKey: string, pair: PairedRow): Side | null {
	if (selectionComment?.hunkKey !== hunkKey) return null;

	for (const cell of [pair.left, pair.right]) {
		if (cell?.lineIdx === selectionComment.lineIndex)
			return splitSide(cell.line);
	}
	return null;
}

let list = $state<DiffListHandle | null>(null);

const model = $derived(
	measure("diff.buildRows", (observation) => {
		observation.attr("lines", countLines(fileDiffs));

		return buildSplitRows(fileDiffs, {
			content: contentMode,
			comments: viewComments,
			reviewFilter,
			collapsed: collapsedFiles,
			// The per-file header bar is the multi-file view's; with one file
			// selected the top bar already shows the path.
			fileHeaders: selectedPath === null,
			tabSize: TAB_SIZE,
			invisibles: showInvisibles,
			composer: composer?.place,
		});
	}),
);

const vd = createVirtualizedDiff({
	layout: "split",
	model: () => model,
	wordWrap: () => wordWrap,
	composer: () => composer?.place,
	list: () => list,
	startAt: () => startAt,
	content: () => contentMode,
});

function hunkLinesOf(path: string, hunkIdx: number): DiffLine[] {
	return fileDiffs.find((fd) => fd.path === path)?.hunks[hunkIdx]?.lines ?? [];
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

function originClass(origin: string): string {
	if (origin === "Add") return "diff-line-add";
	if (origin === "Delete") return "diff-line-delete";
	return "diff-line-context";
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

<!-- One side's code, inside the window the pan translates. `word-break` is not a
     style choice: rowHeights' ceil(columns / available) is only a height when
     the break is unconditional, so it is declared here with the height it
     belongs to. -->
{#snippet cellContent(line: DiffLine, side: "old" | "new", index: number)}
	<span
		class="diff-line-content select-text cursor-text"
		data-code-line={side}
		class:whitespace-pre-wrap={vd.wrapActive}
		class:whitespace-pre={!vd.wrapActive}
		class:break-all={vd.wrapActive}
		class:break-normal={!vd.wrapActive}
		>{@render diffLineText(
			line,
			showInvisibles,
			activeMatch?.row === index && activeMatch.side === side
				? activeMatch
				: null,
		)}</span
	>
{/snippet}

<!-- A cell's marker and line number. The number is the grip a press selects
     the line from, on a changed line, and on an unchanged one where it can take
     a comment. -->
{#snippet cellGutter(
	path: string,
	hunkIdx: number,
	line: DiffLine,
	lineIdx: number,
	marker: LineMarker | null,
	lineno: number | null,
)}
	{@const hunkLines = hunkLinesOf(path, hunkIdx)}
	<ThreadMarker {marker} width={vd.markerW} />
	{#if selectable(line)}
		<GutterGrip
			aria-label={gripLabel(line)}
			onmousedown={(e) => onlinemousedown(path, hunkIdx, lineIdx, hunkLines, e)}
			onkeydown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onlineclick(
						path,
						hunkIdx,
						lineIdx,
						hunkLines,
						new MouseEvent("click", { shiftKey: e.shiftKey }),
					);
				}
			}}
		>
			<span class="split-gutter" style:min-width={vd.gutterW}
				>{lineno ?? ""}</span
			>
		</GutterGrip>
	{:else}
		<span class="split-gutter" style:min-width={vd.gutterW}
			>{lineno ?? ""}</span
		>
	{/if}
{/snippet}

{#snippet splitRow(item: DiffRow, index: number)}
	{#if item.kind === "pair"}
		{@const hunkKey = `${item.path}-${item.hunkIdx}`}
		<!-- The row, not the cell, is what the pan is held against: it is pinned at
         the viewport's left edge and spans one viewport, and the two halves
         translate inside it. -->
		{@const heldOn = actionSide(hunkKey, item.row)}
		<div
			class="split-row pan-pinned flex"
			data-split-code-row
			class:holds-action={heldOn !== null}
			class:run-flash={vd.flashLit(index)}
		>
			{#if item.row.left}
				{@const line = item.row.left.line}
				{@const lineIdx = item.row.left.lineIdx}
				{@const isSelected = inSelection(hunkKey, lineIdx)}
				<div
					class="split-cell split-cell-left diff-line text-diff-text {originClass(
						line.origin,
					)}"
					style:font-family={DIFF_ROW_FONT.fontFamily}
					style:font-size={DIFF_ROW_FONT.fontSize}
					style:line-height={DIFF_ROW_FONT.lineHeight}
					class:in-selection={isSelected}
					class:selection-first={isSelected &&
						!inSelection(hunkKey, lineIdx - 1)}
					class:selection-last={isSelected &&
						!inSelection(hunkKey, lineIdx + 1)}
					style:background={lineBackground(line.origin)}
					data-line-path={item.path}
					data-hunk-index={item.hunkIdx}
					data-line-index={lineIdx}
				>
					{@render cellGutter(
						item.path,
						item.hunkIdx,
						line,
						lineIdx,
						item.markerLeft,
						line.old_lineno,
					)}
					<div class="split-window overflow-clip">
						<div
							class="split-pan pan-left min-w-full"
							class:w-full={vd.wrapActive}
							class:w-max={!vd.wrapActive}
						>
							{@render cellContent(line, "old", index)}
						</div>
					</div>
				</div>
			{:else}
				<div class="split-cell split-cell-left split-phantom"></div>
			{/if}

			{#if item.row.right}
				{@const line = item.row.right.line}
				{@const lineIdx = item.row.right.lineIdx}
				{@const isSelected = inSelection(hunkKey, lineIdx)}
				<div
					class="split-cell diff-line text-diff-text {originClass(line.origin)}"
					style:font-family={DIFF_ROW_FONT.fontFamily}
					style:font-size={DIFF_ROW_FONT.fontSize}
					style:line-height={DIFF_ROW_FONT.lineHeight}
					class:in-selection={isSelected}
					class:selection-first={isSelected &&
						!inSelection(hunkKey, lineIdx - 1)}
					class:selection-last={isSelected &&
						!inSelection(hunkKey, lineIdx + 1)}
					style:background={lineBackground(line.origin)}
					data-line-path={item.path}
					data-hunk-index={item.hunkIdx}
					data-line-index={lineIdx}
				>
					{@render cellGutter(
						item.path,
						item.hunkIdx,
						line,
						lineIdx,
						item.markerRight,
						line.new_lineno,
					)}
					<div class="split-window overflow-clip">
						<div
							class="split-pan pan-right min-w-full"
							class:w-full={vd.wrapActive}
							class:w-max={!vd.wrapActive}
						>
							{@render cellContent(line, "new", index)}
						</div>
					</div>
				</div>
			{:else}
				<div class="split-cell split-phantom"></div>
			{/if}
			{#if heldOn}
				<!-- On the row rather than in its cell, since a cell clips what
				     overflows it and the action straddles the line's bottom edge. -->
				<span class="split-action" class:split-action-old={heldOn === "Old"}
					><SelectionComment oncomment={oncommentselection} /></span
				>
			{/if}
		</div>
	{:else if item.kind === "hunk-header"}
		{@const hunkKey = `${item.path}-${item.hunkIdx}`}
		{@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
		<div
			class="split-hunk-header pan-pinned box-border"
			class:hunk-highlight={vd.flashLit(index)}
		>
			<span class="split-hunk-header-text">{item.header}</span>
			<HunkActions
				path={item.path}
				hunkIdx={item.hunkIdx}
				{diffKind}
				{hasSelection}
				{selectedCount}
				{selectedChangeCount}
				{takesComments}
				{isMerge}
				{hunkOperationInFlight}
				{onstagehunk}
				{onunstagehunk}
				{ondiscardhunk}
				{onstagelines}
				{onunstagelines}
				{ondiscardlines}
				{oncommentlines}
				{oncommenthunk}
			/>
		</div>
	{:else if item.kind === "comment"}
		<div class="split-comment-row pan-pinned">
			{#each item.threads as c (c.id)}
				<div> {@render threadCard(c)} </div>
			{/each}
		</div>
	{:else if item.kind === "composer" && composer}
		<div class="split-composer-row pan-pinned">{@render composer.card()}</div>
	{:else if item.kind === "file-header"}
		<div class="pan-pinned">
			<DiffFileHeader {item} ontoggle={onfilecollapsetoggle} />
		</div>
	{:else if item.kind === "binary"}
		<div class="binary-row pan-pinned">{item.text}</div>
	{/if}
{/snippet}

<div
	class="split-view"
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
	style:--max-l="{vd.maxLeftPx}px"
	style:--max-r="{vd.maxRightPx}px"
	data-code-selection
	bind:this={vd.pane}
>
	{#if vd.ready}
		<ExactVirtualList
			bind:this={list}
			items={model.rows}
			heights={vd.heights}
			contentWidth={vd.contentWidth}
			trailingSpace={SELECTION_COMMENT_CLEARANCE}
			renderItem={splitRow}
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

<style>
.split-view {
	position: absolute;
	inset: 0;
}

/* Pinned against the pan: one viewport wide and held at the scrollport's left
   edge, so a wide file scrolling sideways leaves it where it is. */
.pan-pinned {
	position: sticky;
	left: 0;
	width: 100cqi;
}

.metrics-probe {
	position: absolute;
	top: 0;
	left: 0;
	visibility: hidden;
	pointer-events: none;
	z-index: -1;
}

/* One half of the row. `clip` rather than `hidden` so a cell never becomes a
     scroll container and cannot steal a wheel or be scrolled by focus. */
.split-cell {
	display: flex;
	align-items: flex-start;
	padding: 0 var(--space-2);
	box-sizing: border-box;
	width: 50cqi;
	overflow: clip;
}

/* The divider between the halves. Under border-box it comes out of the left
     half's own width, so the right half's ceiling over-reserves by this 1px —
     the safe direction: the pan may reach a pixel past the last character,
     never stop short of it. */
.split-cell-left {
	border-right: 1px solid var(--color-border);
}

/* The window the pan happens inside. The gutter is its sibling, not its child,
     so the line numbers stay put while the code moves. */
/* Spans the half the action belongs to, as a flex row whose end the action's
   track sits at. */
.split-action {
	position: absolute;
	right: 0;
	bottom: 0;
	display: flex;
	width: 50cqi;
	height: 0;
}
.split-action-old {
	right: 50%;
	padding-right: var(--space-4);
}
.split-window {
	flex: 1;
	min-width: 0;
}

/* The pan, clamped to this side's own end so a short side stops where its text
     does instead of panning into blank. It rides the content INSIDE the clipping
     window, never the window: transforming the clipper moves its clip box too,
     which slides the whole half out of the cell instead of panning within it.
     The pan's width is `max-content` only while unwrapped: that is what gives a
     line its full width to translate across, and a wrapped half has nothing to
     pan, so max-content there would run the line past the window instead of
     wrapping into the height `rowHeights` predicted for it. */
.pan-left {
	transform: translateX(
		calc(-1 * min(var(--pan-x, 0px), max(0px, var(--max-l) - 50cqi)))
	);
}
.pan-right {
	transform: translateX(
		calc(-1 * min(var(--pan-x, 0px), max(0px, var(--max-r) - 50cqi)))
	);
}

.split-gutter {
	text-align: right;
	color: var(--color-text-muted);
	padding-right: var(--space-2);
	user-select: none;
	-webkit-user-select: none;
	flex-shrink: 0;
}

.split-phantom {
	background: var(--color-diff-phantom-bg);
}

/* The hunk header's height is the declared token the row model computes
     offsets from, not whatever the button cluster happens to measure. */
.split-hunk-header {
	background: color-mix(
		in oklch,
		var(--color-info) 6%,
		var(--color-surface-raised)
	);
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: 0 var(--space-2);
	height: var(--diff-hunk-header-height);
	z-index: 1;
}
.split-hunk-header-text {
	flex: 1;
	color: color-mix(in oklch, var(--color-info) 70%, var(--color-text-subtle));
	font-size: var(--text-small);
	font-family: var(--font-mono);
}

.binary-row {
	height: var(--diff-binary-row-height);
	box-sizing: border-box;
	padding: var(--space-2);
	color: var(--color-text-muted);
	font-size: var(--text-callout);
	line-height: var(--text-callout--line-height);
}

.hunk-highlight {
	animation: hunk-flash var(--diff-flash-duration) ease-out;
}
/* Over each half, since the halves paint their own backgrounds above the row's. */
.run-flash > * {
	animation: run-flash var(--diff-flash-duration) ease-out;
}
/* Under reduced motion the flash holds its colour and clears at once, so the
   place a jump landed is still marked. */
@media (prefers-reduced-motion: reduce) {
	.hunk-highlight,
	.run-flash > * {
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
@keyframes hunk-flash {
	0% {
		background-color: var(--color-hunk-flash);
	}
	100% {
		background-color: transparent;
	}
}
/* Change-indicator accent bar: saturated for add/delete, neutral rail for context.
     Every cell carries the 3px border so the columns stay aligned regardless of origin. */
.diff-line {
	position: relative;
	/* Own stacking context so the z-index:-1 hover overlay below resolves
       against this cell (painting over its inline background) instead of
       slipping behind it. */
	isolation: isolate;
	border-left: 3px solid var(--color-border);
}
.diff-line-add {
	border-left-color: var(--color-diff-add);
}
.diff-line-delete {
	border-left-color: var(--color-diff-delete);
}

/* Faint full-cell tint while hovering the selectable (right) gutter — signals
     that the line number, not the code, arms staging. z-index:-1 overlay so it
     tints over the inline diff background without hiding it. */
.diff-line:has(:global([data-gutter-grip]:hover))::after {
	content: "";
	position: absolute;
	inset: 0;
	z-index: -1;
	background: color-mix(in oklch, var(--color-hover) 60%, transparent);
	pointer-events: none;
}

/* Inline comment row: a plain full-width row spanning both halves. */
.split-comment-row {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-2);
	box-sizing: border-box;
}

/* The composer row holds its declared height, and the card fills it, so the
   height the row model counts is the height drawn. */
.split-composer-row {
	display: flex;
	height: var(--diff-composer-row-height);
	padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
	box-sizing: border-box;
}
</style>
