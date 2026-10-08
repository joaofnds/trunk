<script lang="ts">
import { onMount } from "svelte";
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import {
	buildSplitRows,
	countLines,
	type DiffComposer,
	type DiffRow,
	FIXED_ROW_HEIGHT_VARS,
	rowIndexForLine,
} from "../../lib/diff-rows.js";
import {
	commentLabel,
	gripLabel,
	splitInvisibles,
	trailingWhitespaceStart,
} from "../../lib/diff-utils.js";
import { measure } from "../../lib/perf.js";
import { deleteThread, editThread } from "../../lib/review-comment-actions.js";
import type { ThreadEditorSession } from "../../lib/review-editors.svelte.js";
import { ALL_THREADS } from "../../lib/review-filter.js";
import { DIFF_ROW_FONT } from "../../lib/row-metrics.js";
import type {
	ContentMode,
	DiffLine,
	DiffOrigin,
	FileDiff,
	Thread,
} from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import GutterGrip from "../../lib/ui/GutterGrip.svelte";
import Row from "../../lib/ui/Row.svelte";
import {
	createVirtualizedDiff,
	type DiffListHandle,
	TAB_SIZE,
} from "../../lib/virtualized-diff.svelte.js";
import ThreadCard from "../ThreadCard.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";
import ThreadMarker from "./ThreadMarker.svelte";

interface Props {
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
	reviewFilter?: import("../../lib/types.js").ReviewFilter;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	/** The open comment composer, drawn under the line its comment ends on. */
	composer?: DiffComposer | null;
	/** Opens a comment on one line, from the control its marker cell shows. */
	oncommentline?: (
		filePath: string,
		hunkIndex: number,
		lineIndex: number,
	) => void;
	isMerge: boolean;
	collapsedFiles: Set<string>;
	onfilecollapsetoggle: (path: string) => void;
	onlineclick: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
		origin: DiffOrigin,
		hunkLines: DiffLine[],
		e: MouseEvent,
	) => void;
	onlinemousedown: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
		origin: DiffOrigin,
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
	reviewCommentsVisible?: boolean;
	viewComments?: Thread[];
}

let {
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
	reviewCommentsVisible = true,
	reviewFilter = ALL_THREADS,
	viewComments = [],
	editorSessionForThread,
	composer = null,
	oncommentline,
}: Props = $props();

// Whether a line can take a new comment here, as the hunk's Comment action can.
const commentable = $derived(
	oncommentline !== undefined && reviewCommentsVisible && !isMerge,
);

const FLASH_MS = 600;

// Staging rebuilds the diff with the same view options the hunk was rendered
// under, so a hunk index means the same hunk on both sides and ignoring
// whitespace no longer has to block the gesture (TRUNK-73). Only an
// in-flight operation holds the buttons now.
const stagingDisabled = $derived(hunkOperationInFlight);
const stagingDisabledTitle: string | undefined = undefined;

let list = $state<
	(DiffListHandle & { scrollToIndex: (index: number) => void }) | null
>(null);

// The flashed hunk's identity, not a class on an element: the element a jump
// targets may not be mounted when the jump happens, and will be replaced by
// another row's node as the reader scrolls away.
let flashedHunkKey = $state<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const model = $derived(
	measure("diff.buildRows", (observation) => {
		observation.attr("lines", countLines(fileDiffs));

		return buildSplitRows(fileDiffs, {
			content: contentMode,
			comments: viewComments,
			reviewCommentsVisible,
			reviewFilter,
			collapsed: collapsedFiles,
			// The per-file header bar is the multi-file view's; with one file
			// selected the top bar already shows the path.
			fileHeaders: selectedPath === null,
			tabSize: TAB_SIZE,
			invisibles: showInvisibles,
			composer: composer?.place,
			commentable,
		});
	}),
);

const vd = createVirtualizedDiff({
	layout: "split",
	model: () => model,
	wordWrap: () => wordWrap,
	composer: () => composer?.place,
	list: () => list,
});

// The factory's own onMount handles the observer; this one only stops a flash
// timer still running at unmount.
onMount(() => {
	return () => {
		if (flashTimer) clearTimeout(flashTimer);
	};
});

function hunkLinesOf(path: string, hunkIdx: number): DiffLine[] {
	return fileDiffs.find((fd) => fd.path === path)?.hunks[hunkIdx]?.lines ?? [];
}

/** How many hunks `[` and `]` step through. */
export function hunkCount(): number {
	return model.hunkNav.length;
}

/** Where a hunk sits in that sequence, or -1 when it is not rendered at all —
 *  a collapsed file's hunks are absent. */
export function ordinalOf(path: string, hunkIdx: number): number {
	return model.hunkNav.findIndex(
		(entry) => entry.path === path && entry.hunkIdx === hunkIdx,
	);
}

export function scrollToHunk(ordinal: number): void {
	const nav = model.hunkNav[ordinal];
	if (!nav) return;

	list?.scrollToIndex(nav.rowIndex);
	flash(`${nav.path}-${nav.hunkIdx}`);
}

/** Scrolls to the pair row carrying one line, on either side. A line the model
 *  does not carry — a collapsed file — falls back to the hunk. */
export function scrollToLine(
	path: string,
	hunkIdx: number,
	lineIdx: number,
): void {
	const rowIndex = rowIndexForLine(model, path, hunkIdx, lineIdx);
	if (rowIndex < 0) {
		scrollToHunk(ordinalOf(path, hunkIdx));
		return;
	}

	list?.scrollToIndex(rowIndex);
	flash(`${path}-${hunkIdx}`);
}

function flash(hunkKey: string): void {
	if (flashTimer) clearTimeout(flashTimer);
	flashedHunkKey = hunkKey;
	flashTimer = setTimeout(() => {
		flashedHunkKey = null;
	}, FLASH_MS);
}

function lineBackground(origin: string, isSelected: boolean = false): string {
	if (origin === "Add")
		return isSelected
			? "var(--color-diff-add-bg-selected)"
			: "var(--color-diff-add-bg)";
	if (origin === "Delete")
		return isSelected
			? "var(--color-diff-delete-bg-selected)"
			: "var(--color-diff-delete-bg)";
	return "transparent";
}

function originClass(origin: string): string {
	if (origin === "Add") return "diff-line-add";
	if (origin === "Delete") return "diff-line-delete";
	return "diff-line-context";
}
</script>

{#snippet threadCard(c: Thread)}
	<ThreadCard
		variant="inline"
		confirmDelete={false}
		thread={c}
		{repoPath}
		onedit={(id, text) => editThread(repoPath, id, text)}
		ondelete={(id) => deleteThread(repoPath, id)}
		{editorSessionForThread}
	/>
{/snippet}

<!-- One side's code, inside the window the pan translates. `word-break` is not a
     style choice: rowHeights' ceil(columns / available) is only a height when
     the break is unconditional, so it is declared here with the height it
     belongs to. -->
{#snippet cellContent(line: DiffLine)}
	{@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
	<span
		class="diff-line-content select-text cursor-text"
		class:whitespace-pre-wrap={vd.wrapActive}
		class:whitespace-pre={!vd.wrapActive}
		class:break-all={vd.wrapActive}
		class:break-normal={!vd.wrapActive}
		>{#if line.spans.length > 0}
			{#each line.spans as span}
				{@const sliced = line.content.slice(span.start, span.end)}
				{@const spanInTrailing = span.start >= trailStart}
				{#if showInvisibles}
					{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}
						<span
							class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}"
							data-glyph={seg.glyph}
							>{seg.text}</span
						>
					{/each}
				{:else}
					<span
						class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}"
						>{sliced}</span
					>
				{/if}
			{/each}
		{:else}
			{#if showInvisibles}
				{@const segments = splitInvisibles(line.content, false)}
				{#each segments as seg}
					<span
						class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}"
						data-glyph={seg.glyph}
						>{seg.text}</span
					>
				{/each}
			{:else}
				{line.content}
			{/if}
		{/if}</span
	>
{/snippet}

{#snippet splitRow(item: DiffRow, _index: number)}
	{#if item.kind === "pair"}
		{@const hunkKey = `${item.path}-${item.hunkIdx}`}
		<!-- The row, not the cell, is what the pan is held against: it is pinned at
         the viewport's left edge and spans one viewport, and the two halves
         translate inside it. -->
		<div class="split-row pan-pinned flex">
			{#if item.row.left}
				{@const line = item.row.left.line}
				{@const isSelected = selectedHunkKey === hunkKey && selectedLineIndices.has(item.row.left.lineIdx)}
				<div
					class="split-cell split-cell-left diff-line text-diff-text {originClass(line.origin)}"
					style:font-family={DIFF_ROW_FONT.fontFamily}
					style:font-size={DIFF_ROW_FONT.fontSize}
					style:line-height={DIFF_ROW_FONT.lineHeight}
					style:background={lineBackground(line.origin, isSelected)}
				>
					{#if model.markerChars > 0}
						<ThreadMarker marker={item.markerLeft} width={vd.markerW} />
					{/if}
					<span class="split-gutter" style:min-width={vd.gutterW}
						>{line.old_lineno ?? ''}</span
					>
					<div class="split-window overflow-clip">
						<div
							class="split-pan pan-left min-w-full"
							class:w-full={vd.wrapActive}
							class:w-max={!vd.wrapActive}
						>
							{@render cellContent(line)}
						</div>
					</div>
				</div>
			{:else}
				<div class="split-cell split-cell-left split-phantom"></div>
			{/if}

			{#if item.row.right}
				{@const line = item.row.right.line}
				{@const lineIdx = item.row.right.lineIdx}
				{@const isSelectable = line.origin === 'Add'}
				{@const isSelected = selectedHunkKey === hunkKey && selectedLineIndices.has(lineIdx)}
				<div
					class="split-cell diff-line text-diff-text {originClass(line.origin)}"
					style:font-family={DIFF_ROW_FONT.fontFamily}
					style:font-size={DIFF_ROW_FONT.fontSize}
					style:line-height={DIFF_ROW_FONT.lineHeight}
					style:background={lineBackground(line.origin, isSelected)}
					data-line-path={item.path}
					data-hunk-index={item.hunkIdx}
					data-line-index={lineIdx}
				>
					{#if model.markerChars > 0}
						<ThreadMarker
							marker={item.markerRight}
							width={vd.markerW}
							oncomment={commentable && isSelectable
								? () => oncommentline?.(item.path, item.hunkIdx, lineIdx)
								: undefined}
							commentLabel={commentLabel(line)}
						/>
					{/if}
					{#if isSelectable}
						<GutterGrip
							aria-label={gripLabel(line)}
							onmousedown={(e) => onlinemousedown(item.path, item.hunkIdx, lineIdx, line.origin, hunkLinesOf(item.path, item.hunkIdx), e)}
							onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onlineclick(item.path, item.hunkIdx, lineIdx, line.origin, hunkLinesOf(item.path, item.hunkIdx), new MouseEvent('click', { shiftKey: e.shiftKey })); } }}
						>
							<span class="split-gutter" style:min-width={vd.gutterW}
								>{line.new_lineno ?? ''}</span
							>
						</GutterGrip>
					{:else}
						<span class="split-gutter" style:min-width={vd.gutterW}
							>{line.new_lineno ?? ''}</span
						>
					{/if}
					<div class="split-window overflow-clip">
						<div
							class="split-pan pan-right min-w-full"
							class:w-full={vd.wrapActive}
							class:w-max={!vd.wrapActive}
						>
							{@render cellContent(line)}
						</div>
					</div>
				</div>
			{:else}
				<div class="split-cell split-phantom"></div>
			{/if}
		</div>
	{:else if item.kind === "hunk-header"}
		{@const hunkKey = `${item.path}-${item.hunkIdx}`}
		{@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
		<div
			class="split-hunk-header pan-pinned box-border{flashedHunkKey === hunkKey ? ' hunk-highlight' : ''}"
		>
			<span class="split-hunk-header-text">{item.header}</span>
			{#if diffKind === 'unstaged'}
				{#if hasSelection}
					<!-- Working-tree Comment affordance (260531-k4j): reuses the
               commit-mode accent button class verbatim (no new color). New-side
               scope + Old-side guard live in the host. Leads the action cluster
               (260531-l02 UX: Comment left of staging). -->
					{#if reviewCommentsVisible}
						<Button
							size="sm"
							variant="accent"
							onclick={() => oncommentlines(item.path, item.hunkIdx)}
							>Comment ({selectedCount})</Button
						>
					{/if}
					<Button
						size="sm"
						variant="danger"
						disabled={stagingDisabled}
						title={stagingDisabledTitle}
						onclick={() => ondiscardlines(item.path, item.hunkIdx)}
						>Discard Lines ({selectedCount})</Button
					>
					<Button
						size="sm"
						variant="success"
						disabled={stagingDisabled}
						title={stagingDisabledTitle}
						onclick={() => onstagelines(item.path, item.hunkIdx)}
						>Stage Lines ({selectedCount})</Button
					>
				{:else}
					<!-- Whole-hunk Comment affordance (260531-l02): comment the hunk
               without selecting lines. Reuses the accent button class verbatim
               (no new color); host applies the New-side guard. -->
					{#if reviewCommentsVisible}
						<Button
							size="sm"
							variant="accent"
							onclick={() => oncommenthunk(item.path, item.hunkIdx)}
							>Comment</Button
						>
					{/if}
					<Button
						size="sm"
						variant="danger"
						disabled={stagingDisabled}
						title={stagingDisabledTitle}
						onclick={() => ondiscardhunk(item.path, item.hunkIdx)}
						>Discard Hunk</Button
					>
					<Button
						size="sm"
						variant="success"
						disabled={stagingDisabled}
						title={stagingDisabledTitle}
						onclick={() => onstagehunk(item.path, item.hunkIdx)}
						>Stage Hunk</Button
					>
				{/if}
			{:else if diffKind === 'staged'}
				{#if hasSelection}
					<!-- Staged Comment (260531-l02b): index-snapshot anchored, both sides
               resolve (no Old-side guard). Leads the cluster. -->
					{#if reviewCommentsVisible}
						<Button
							size="sm"
							variant="accent"
							onclick={() => oncommentlines(item.path, item.hunkIdx)}
							>Comment ({selectedCount})</Button
						>
					{/if}
					<Button
						size="sm"
						variant="warning"
						disabled={stagingDisabled}
						title={stagingDisabledTitle}
						onclick={() => onunstagelines(item.path, item.hunkIdx)}
						>Unstage Lines ({selectedCount})</Button
					>
				{:else}
					{#if reviewCommentsVisible}
						<Button
							size="sm"
							variant="accent"
							onclick={() => oncommenthunk(item.path, item.hunkIdx)}
							>Comment</Button
						>
					{/if}
					<Button
						size="sm"
						variant="warning"
						disabled={stagingDisabled}
						title={stagingDisabledTitle}
						onclick={() => onunstagehunk(item.path, item.hunkIdx)}
						>Unstage Hunk</Button
					>
				{/if}
			{:else if diffKind === 'commit'}
				<!-- Commit-diff Comment (260531-l02): whole-hunk when nothing is
             selected, line-scoped otherwise; both carry the isMerge guard. -->
				{#if reviewCommentsVisible}
					<Button
						size="sm"
						variant="accent"
						disabled={isMerge}
						title={isMerge ? "Diff comments aren't available on merge commits" : ""}
						onclick={() => hasSelection ? oncommentlines(item.path, item.hunkIdx) : oncommenthunk(item.path, item.hunkIdx)}
						>{hasSelection ? `Comment (${selectedCount})` : 'Comment'}</Button
					>
				{/if}
			{/if}
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
		<div class="split-file-header pan-pinned">
			<Row variant="title" onclick={() => onfilecollapsetoggle(item.path)}>
				<span class="split-file-header-caret"
					>{item.collapsed ? '▶' : '▼'}</span
				>
				{item.path}
			</Row>
		</div>
	{:else if item.kind === "binary"}
		<div class="binary-row pan-pinned">Binary file — no diff available</div>
	{/if}
{/snippet}

<div
	class="split-view"
	style:--diff-file-header-height={FIXED_ROW_HEIGHT_VARS["--diff-file-header-height"]}
	style:--diff-hunk-header-height={FIXED_ROW_HEIGHT_VARS["--diff-hunk-header-height"]}
	style:--diff-binary-row-height={FIXED_ROW_HEIGHT_VARS["--diff-binary-row-height"]}
	style:--diff-composer-row-height={FIXED_ROW_HEIGHT_VARS["--diff-composer-row-height"]}
	style:--max-l="{vd.maxLeftPx}px"
	style:--max-r="{vd.maxRightPx}px"
	bind:this={vd.pane}
>
	{#if vd.ready}
		<ExactVirtualList
			bind:this={list}
			items={model.rows}
			heights={vd.heights}
			contentWidth={vd.contentWidth}
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

	{#if vd.threadsToProbe.length > 0}
		<div class="comment-probe" bind:this={vd.commentProbe}>
			{#each vd.threadsToProbe as c (c.id)}
				<div class="split-comment-row" data-probe-thread-id={c.id}
					>{@render threadCard(c)}</div
				>
			{/each}
		</div>
	{/if}
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

/* Both probes are laid out at the row's real width so their measurements are
     the ones the rendered rows will produce, and neither is visible or
     hit-testable. */
.metrics-probe,
.comment-probe {
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

/* Multi-file view only. Vertical stickiness does not survive the list — a row
     inside a translated container has no scrollport-relative flow position. */
.split-file-header {
	height: var(--diff-file-header-height);
}
.split-file-header-caret {
	font-size: var(--text-caption);
	color: var(--color-text-muted);
	width: calc(5 * var(--u) / 2);
	display: inline-block;
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
	animation: hunk-flash 0.6s ease-out;
}
@keyframes hunk-flash {
	0% {
		background-color: var(--color-hunk-flash);
	}
	100% {
		background-color: transparent;
	}
}
.word-add {
	background-color: var(--color-diff-word-add-bg);
	border-radius: var(--radius);
}
.word-delete {
	background-color: var(--color-diff-word-delete-bg);
	border-radius: var(--radius);
}

/* Syntax highlighting classes */
.syn-keyword {
	color: var(--color-syn-keyword);
}
.syn-string {
	color: var(--color-syn-string);
}
.syn-comment {
	color: var(--color-syn-comment);
}
.syn-number {
	color: var(--color-syn-number);
}
.syn-type {
	color: var(--color-syn-type);
}
.syn-function {
	color: var(--color-syn-function);
}
.syn-variable {
	color: var(--color-syn-variable);
}
.syn-constant {
	color: var(--color-syn-constant);
}
.syn-operator {
	color: var(--color-syn-operator);
}
.syn-punctuation {
	color: var(--color-syn-punctuation);
}
.syn-attribute {
	color: var(--color-syn-attribute);
}
.syn-tag {
	color: var(--color-syn-tag);
}
.syn-property {
	color: var(--color-syn-property);
}
.syn-regex {
	color: var(--color-syn-regex);
}
.syn-escape {
	color: var(--color-syn-escape);
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

/* Invisible character styling. Real whitespace stays in the text node (so it
     copies faithfully) at zero width via font-size:0; the ·/→ glyph is painted by
     a pseudo-element, never part of the selection/clipboard. font-size:0 also keeps
     a real tab at one visual cell instead of advancing to a tab stop. */
.invisible-char {
	font-size: 0;
}
.invisible-char::before {
	content: attr(data-glyph);
	font-size: var(--text-callout);
	color: var(--color-invisible);
}

/* Trailing whitespace warning */
.trailing-ws {
	background-color: var(--color-trailing-ws-bg);
}
.trailing-ws::before {
	color: var(--color-trailing-ws-fg);
}

/* Text on a word patch is the primary diff color, whatever its syntax class
     or marker role. The patch is strong enough that no syntax hue clears AAA
     on it (see --color-diff-word-add-bg); last so it wins every equal-
     specificity color rule above. */
.word-add,
.word-delete,
.word-add::before,
.word-delete::before {
	color: var(--color-diff-text);
}
/* Trailing whitespace inside a word patch keeps the patch color: its own red
     tint on top would take the glyph below AAA on a selected line, and the
     patch plus the marker glyph already say everything the tint said. */
.word-add.trailing-ws {
	background-color: var(--color-diff-word-add-bg);
}
.word-delete.trailing-ws {
	background-color: var(--color-diff-word-delete-bg);
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
