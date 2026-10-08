<script lang="ts">
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import {
	buildInlineRows,
	countLines,
	type DiffComposer,
	type DiffRow,
	FIXED_ROW_HEIGHT_VARS,
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
	DiffLine,
	FileDiff,
	ReviewFilter,
	Thread,
} from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import GutterGrip from "../../lib/ui/GutterGrip.svelte";
import {
	createVirtualizedDiff,
	type DiffListHandle,
	TAB_SIZE,
} from "../../lib/virtualized-diff.svelte.js";
import ThreadCard from "../ThreadCard.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";
import ThreadMarker from "./ThreadMarker.svelte";

interface Props {
	fileDiffs: FileDiff[];
	showInvisibles: boolean;
	wordWrap: boolean;
	repoPath: string;
	diffKind: PanelDiffKind;
	isMerge: boolean;
	// Bubbles the chosen file path + the flat selected indices (into the file's
	// hunks.flatMap(h => h.lines)) up to the DiffPanel host when the user clicks
	// the Comment affordance.
	oncommentfullfile: (filePath: string, selectedIndices: Set<number>) => void;
	/** A shift-click stretched the selection to these lines, which the comment
	 *  being written follows. */
	onextendcomment?: (filePath: string, selectedIndices: Set<number>) => void;
	reviewCommentsVisible?: boolean;
	reviewFilter?: ReviewFilter;
	viewComments?: Thread[];
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
	/** The open comment composer, drawn under the line its comment ends on. */
	composer?: DiffComposer | null;
}

let {
	fileDiffs,
	showInvisibles,
	wordWrap,
	repoPath = "",
	diffKind,
	isMerge,
	oncommentfullfile,
	onextendcomment,
	reviewCommentsVisible = true,
	reviewFilter = ALL_THREADS,
	viewComments = [],
	editorSessionForThread,
	composer = null,
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

// The contiguous span as flat indices into the active file's line list.
const selectedIndices = $derived(computeSpan(anchorIndex, focusIndex));

const model = $derived(
	measure("diff.buildRows", (observation) => {
		observation.attr("lines", countLines(fileDiffs));

		return buildInlineRows(fileDiffs, {
			content: "full",
			comments: viewComments,
			reviewCommentsVisible,
			reviewFilter,
			collapsed: new Set<string>(),
			fileHeaders: false,
			tabSize: TAB_SIZE,
			invisibles: showInvisibles,
			composer: composer?.place,
			commentable,
		});
	}),
);

const vd = createVirtualizedDiff({
	layout: "inline",
	model: () => model,
	wordWrap: () => wordWrap,
	composer: () => composer?.place,
	list: () => list,
});

// An allowlist, not a denylist: a diff kind the store cannot anchor a thread
// against must not gain the affordance by being forgotten here.
// Whether a line can take a new comment here, as the Comment action can.
const commentable = $derived(
	reviewCommentsVisible &&
		(diffKind === "commit" ||
			diffKind === "unstaged" ||
			diffKind === "current_file"),
);

// The marker cell's control: comment on that one line, selecting it as a click
// on its grip would.
function commentOnLine(path: string, line: DiffLine, index: number) {
	selectLine(path, line, index, false);
	oncommentfullfile(path, new Set([index]));
}

const affordanceVisible = $derived(
	reviewCommentsVisible &&
		(diffKind === "commit" ||
			diffKind === "unstaged" ||
			diffKind === "current_file") &&
		selectedPath !== null &&
		selectedIndices.size > 0,
);

$effect(() => {
	window.addEventListener("mouseup", stopDrag);
	return () => {
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

	selectLine(path, line, index, e.shiftKey);
	document.addEventListener("mouseover", extendDrag);
}

function stopDrag() {
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
	if (linePath !== selectedPath || newSide === undefined) return;

	focusIndex = Number(row.dataset.flatIndex);
}

// Called by the DiffPanel host (via bind:this) on mode/layout toggle and Escape
// so the selection never goes stale.
export function clearSelection() {
	selectedPath = null;
	anchorIndex = null;
	focusIndex = null;
}

function lineBackground(origin: string, isSelected: boolean): string {
	if (isSelected) {
		if (origin === "Add") return "var(--color-diff-add-bg-selected)";
		if (origin === "Delete") return "var(--color-diff-delete-bg-selected)";
		return "var(--color-accent-bg)";
	}
	if (origin === "Add") return "var(--color-diff-add-bg)";
	if (origin === "Delete") return "var(--color-diff-delete-bg)";
	return "transparent";
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

{#snippet lineNumbers(line: DiffLine)}
	<span class="gutter-num" style:min-width={vd.gutterW}
		>{line.old_lineno ?? ''}</span
	><span class="gutter-num" style:min-width={vd.gutterW}
		>{line.new_lineno ?? ''}</span
	>
{/snippet}

{#snippet diffRow(item: DiffRow, _index: number)}
	{#if item.kind === "line"}
		{@const line = item.line}
		{@const isSelectable = line.new_lineno !== null}
		{@const isSelected = selectedPath === item.path && selectedIndices.has(item.flatIdx)}
		{@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
		<div
			class="diff-line flex items-start px-2 text-diff-text {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}"
			class:whitespace-pre-wrap={vd.wrapActive}
			class:whitespace-pre={!vd.wrapActive}
			class:break-all={vd.wrapActive}
			class:break-normal={!vd.wrapActive}
			style:font-family={DIFF_ROW_FONT.fontFamily}
			style:font-size={DIFF_ROW_FONT.fontSize}
			style:line-height={DIFF_ROW_FONT.lineHeight}
			style:background={lineBackground(line.origin, isSelected)}
			data-line-path={item.path}
			data-flat-index={item.flatIdx}
			data-new-side={isSelectable ? "" : undefined}
			>{#if model.markerChars > 0}
				<ThreadMarker
					marker={item.marker}
					width={vd.markerW}
					oncomment={commentable && isSelectable
						? () => commentOnLine(item.path, line, item.flatIdx)
						: undefined}
					commentLabel={commentLabel(line)}
				/>
			{/if}{#if isSelectable}
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
			{/if}<span class="diff-line-content select-text cursor-text"
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
			></div
		>
	{:else if item.kind === "comment"}
		{#each item.threads as c (c.id)}
			<div class="comment-row pan-pinned">{@render threadCard(c)}</div>
		{/each}
	{:else if item.kind === "composer" && composer}
		<div class="composer-row pan-pinned">{@render composer.card()}</div>
	{:else if item.kind === "binary"}
		<div class="binary-row">Binary file — no diff available</div>
	{/if}
{/snippet}

<div
	class="full-file"
	style:--diff-file-header-height={FIXED_ROW_HEIGHT_VARS["--diff-file-header-height"]}
	style:--diff-hunk-header-height={FIXED_ROW_HEIGHT_VARS["--diff-hunk-header-height"]}
	style:--diff-binary-row-height={FIXED_ROW_HEIGHT_VARS["--diff-binary-row-height"]}
	style:--diff-composer-row-height={FIXED_ROW_HEIGHT_VARS["--diff-composer-row-height"]}
>
	{#if affordanceVisible}
		<!-- Full-file Comment affordance (L-05: no isMerge disable). Appears on
         comment-capable commit, unstaged working-tree (260531-k4j), and
         current-file views once a selection exists. Lives outside the list
         because it follows the live selection, which the row model must not
         take as an input. -->
		<div class="flex justify-end py-1 px-2 flex-none">
			<Button
				variant="accent"
				size="sm"
				data-testid="full-file-comment"
				onclick={() => selectedPath && oncommentfullfile(selectedPath, selectedIndices)}
			>
				Comment ({selectedIndices.size})
			</Button>
		</div>
	{/if}

	<div class="list-area" bind:this={vd.pane}>
		{#if vd.ready}
			<ExactVirtualList
				bind:this={list}
				items={model.rows}
				heights={vd.heights}
				contentWidth={vd.contentWidth}
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

		{#if vd.threadsToProbe.length > 0}
			<div class="comment-probe" bind:this={vd.commentProbe}>
				{#each vd.threadsToProbe as c (c.id)}
					<div
						class="comment-row"
						data-probe-thread-id={c.id}
						style:display={reviewFilter !== "none" ? "block" : "none"}
						>{@render threadCard(c)}</div
					>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
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
.binary-row {
	height: var(--diff-binary-row-height);
	box-sizing: border-box;
	padding: var(--space-2);
	color: var(--color-text-muted);
	font-size: var(--text-callout);
	line-height: var(--text-callout--line-height);
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

/* Comment rows hang as block siblings directly under their anchored line,
     indented to clear the change-indicator rail by as much as the composer row,
     so a card and the composer under it share their edges. One viewport wide,
     so the probe measures a card at the width the pinned row draws it. */
.comment-row {
	padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
	width: 100cqi;
	box-sizing: border-box;
}

/* Invisible character styling (Phase 63 -- WHSP-03, D-11). Real whitespace stays
     in the text node (so it copies faithfully) at zero width via font-size:0; the
     ·/→ glyph is painted by a pseudo-element, never part of the selection/clipboard.
     font-size:0 also keeps a real tab at one visual cell, not a tab stop. */
.invisible-char {
	font-size: 0;
}
.invisible-char::before {
	content: attr(data-glyph);
	font-size: var(--text-callout);
	color: var(--color-invisible);
}

/* Trailing whitespace warning (Phase 63 -- D-12) */
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
.composer-row {
	display: flex;
	height: var(--diff-composer-row-height);
	padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
	box-sizing: border-box;
}
</style>
