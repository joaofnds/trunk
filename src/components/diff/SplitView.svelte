<script lang="ts">
import { onMount } from "svelte";
import {
	buildSplitRows,
	type DiffRow,
	FIXED_ROW_HEIGHT_VARS,
	rowIndexForLine,
} from "../../lib/diff-rows.js";
import {
	splitInvisibles,
	trailingWhitespaceStart,
} from "../../lib/diff-utils.js";
import { measure } from "../../lib/perf.js";
import {
	addReply,
	deleteReply,
	deleteThread,
	editReply,
	editThread,
	setThreadState,
} from "../../lib/review-comment-actions.js";
import { DIFF_ROW_FONT } from "../../lib/row-metrics.js";
import type {
	ContentMode,
	DiffLine,
	DiffOrigin,
	FileDiff,
	Thread,
} from "../../lib/types.js";
import {
	createVirtualizedDiff,
	TAB_SIZE,
} from "../../lib/virtualized-diff.svelte.js";
import ThreadCard from "../ThreadCard.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";

interface Props {
	contentMode: ContentMode;
	fileDiffs: FileDiff[];
	selectedPath: string | null;
	diffKind: "unstaged" | "staged" | "commit";
	hunkOperationInFlight: boolean;
	ignoreWhitespace: boolean;
	showInvisibles: boolean;
	wordWrap: boolean;
	selectedHunkKey: string | null;
	selectedLineIndices: Set<number>;
	selectedCount: number;
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
	onlineenter: (
		filePath: string,
		hunkIdx: number,
		lineIndex: number,
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
	showInlineComments?: boolean;
	viewComments?: Thread[];
}

let {
	contentMode,
	fileDiffs,
	selectedPath,
	diffKind,
	hunkOperationInFlight,
	ignoreWhitespace,
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
	onlineenter,
	onstagehunk,
	onunstagehunk,
	ondiscardhunk,
	onstagelines,
	onunstagelines,
	ondiscardlines,
	oncommentlines,
	oncommenthunk,
	repoPath = "",
	showInlineComments = true,
	viewComments = [],
}: Props = $props();

const FLASH_MS = 600;

const stagingDisabled = $derived(hunkOperationInFlight || ignoreWhitespace);
const stagingDisabledTitle = $derived(
	ignoreWhitespace
		? "Staging is disabled while whitespace changes are ignored"
		: undefined,
);

let list = $state<{
	topIndex: () => number;
	anchorTo: (index: number) => void;
	scrollToIndex: (index: number) => void;
} | null>(null);

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
			showInlineComments,
			collapsed: collapsedFiles,
			// The per-file header bar is the multi-file view's; with one file
			// selected the top bar already shows the path.
			fileHeaders: selectedPath === null,
			tabSize: TAB_SIZE,
			invisibles: showInvisibles,
		});
	}),
);

const vd = createVirtualizedDiff({
	layout: "split",
	model: () => model,
	wordWrap: () => wordWrap,
	list: () => list,
});

// The factory's own onMount handles the observer; this one only stops a flash
// timer still running at unmount.
onMount(() => {
	return () => {
		if (flashTimer) clearTimeout(flashTimer);
	};
});

function countLines(diffs: FileDiff[]): number {
	let total = 0;
	for (const fd of diffs) {
		for (const hunk of fd.hunks) total += hunk.lines.length;
	}
	return total;
}

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

// One half's geometry, stated once: `clip` rather than `hidden` so a cell never
// becomes a scroll container and cannot steal a wheel or be scrolled by focus.
const HALF_GEOMETRY = "width: 50cqi; overflow: clip;";

function cellStyle(origin: string, isSelected: boolean): string {
	return `${DIFF_ROW_FONT}; ${HALF_GEOMETRY} background: ${lineBackground(origin, isSelected)}; color: var(--color-diff-text);`;
}

/** The pan, clamped to this side's own end so a short side stops where its text
 *  does instead of panning into blank. It rides the content INSIDE the clipping
 *  window, never the window: transforming the clipper moves its clip box too,
 *  which slides the whole half out of the cell instead of panning within it. */
function panTransform(ceiling: "--max-l" | "--max-r"): string {
	// `max-content` is what gives an unwrapped line its full width to translate
	// across; a wrapped half has nothing to pan, and max-content there would run
	// the line past the window instead of wrapping into the height `rowHeights`
	// predicted for it.
	const width = vd.wrapActive ? "100%" : "max-content";
	return `width: ${width}; min-width: 100%; transform: translateX(calc(-1 * min(var(--pan-x, 0px), max(0px, var(${ceiling}) - 50cqi))));`;
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
    onedit={(id, text) => editThread(repoPath, id, text)}
    onreplyadd={(id, text) => addReply(repoPath, id, text)}
    onstatechange={(id, next) => setThreadState(repoPath, id, next)}
    onreplyedit={(id, text) => editReply(repoPath, id, text)}
    onreplydelete={(id) => deleteReply(repoPath, id)}
    ondelete={(id) => deleteThread(repoPath, id)}
  />
{/snippet}

<!-- One side's code, inside the window the pan translates. `word-break` is not a
     style choice: rowHeights' ceil(columns / available) is only a height when
     the break is unconditional, so it is declared here with the height it
     belongs to. -->
{#snippet cellContent(line: DiffLine)}
  {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
  <span class="diff-line-content" style="white-space: {vd.wrapActive ? 'pre-wrap' : 'pre'}; word-break: {vd.wrapActive ? 'break-all' : 'normal'}; user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span>
{/snippet}

{#snippet splitRow(item: DiffRow, _index: number)}
  {#if item.kind === "pair"}
    {@const hunkKey = `${item.path}-${item.hunkIdx}`}
    <!-- The row, not the cell, is what the pan is held against: it is sticky at
         the viewport's left edge and spans one viewport, and the two halves
         translate inside it. jsdom reads only inline styles, so every
         load-bearing declaration here is inline. -->
    <div class="split-row" style="position: sticky; left: 0; width: 100cqi; display: flex;">
      {#if item.row.left}
        {@const line = item.row.left.line}
        {@const isSelected = selectedHunkKey === hunkKey && selectedLineIndices.has(item.row.left.lineIdx)}
        <div
          class="split-cell split-cell-left diff-line {originClass(line.origin)}{item.spannedLeft ? ' diff-line-commented' : ''}"
          style={cellStyle(line.origin, isSelected)}
        >
          <span class="split-gutter" style="min-width: {vd.gutterW};">{line.old_lineno ?? ''}</span>
          <div class="split-window" style="overflow: clip;">
            <div class="split-pan" style={panTransform('--max-l')}>
              {@render cellContent(line)}
            </div>
          </div>
        </div>
      {:else}
        <div class="split-cell split-cell-left split-phantom" style={HALF_GEOMETRY}></div>
      {/if}

      {#if item.row.right}
        {@const line = item.row.right.line}
        {@const lineIdx = item.row.right.lineIdx}
        {@const isSelectable = line.origin === 'Add'}
        {@const isSelected = selectedHunkKey === hunkKey && selectedLineIndices.has(lineIdx)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- mouseenter only continues an in-progress gutter drag (guarded by
             `dragging` in the host); the cell is not a control. -->
        <div
          class="split-cell diff-line {originClass(line.origin)}{item.spannedRight ? ' diff-line-commented' : ''}"
          style={cellStyle(line.origin, isSelected)}
          onmouseenter={(e) => onlineenter(item.path, item.hunkIdx, lineIdx, e)}
        >
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <span
            class="split-gutter{isSelectable ? ' gutter-selectable' : ''}"
            style="min-width: {vd.gutterW};"
            role={isSelectable ? 'button' : undefined}
            tabindex={isSelectable ? 0 : undefined}
            onmousedown={(e) => { if (isSelectable) onlinemousedown(item.path, item.hunkIdx, lineIdx, line.origin, hunkLinesOf(item.path, item.hunkIdx), e); }}
            onkeydown={(e) => { if (isSelectable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onlineclick(item.path, item.hunkIdx, lineIdx, line.origin, hunkLinesOf(item.path, item.hunkIdx), new MouseEvent('click', { shiftKey: e.shiftKey })); } }}
          >{line.new_lineno ?? ''}</span>
          <div class="split-window" style="overflow: clip;">
            <div class="split-pan" style={panTransform('--max-r')}>
              {@render cellContent(line)}
            </div>
          </div>
        </div>
      {:else}
        <div class="split-cell split-phantom" style={HALF_GEOMETRY}></div>
      {/if}
    </div>
  {:else if item.kind === "hunk-header"}
    {@const hunkKey = `${item.path}-${item.hunkIdx}`}
    {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
    <div
      class="split-hunk-header{flashedHunkKey === hunkKey ? ' hunk-highlight' : ''}"
      style="position: sticky; left: 0; width: 100cqi; height: var(--diff-hunk-header-height); box-sizing: border-box;"
    >
      <span class="split-hunk-header-text">{item.header}</span>
      {#if diffKind === 'unstaged'}
        {#if hasSelection}
          <!-- Working-tree Comment affordance (260531-k4j): reuses the
               commit-mode accent button class verbatim (no new color). New-side
               scope + Old-side guard live in the host. Leads the action cluster
               (260531-l02 UX: Comment left of staging). -->
          {#if showInlineComments}
          <button
            class="staging-btn accent-btn"
            onclick={() => oncommentlines(item.path, item.hunkIdx)}
          >Comment ({selectedCount})</button>
          {/if}
          <button
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            class="staging-btn danger-btn"
            onclick={() => ondiscardlines(item.path, item.hunkIdx)}
          >Discard Lines ({selectedCount})</button>
          <button
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            class="staging-btn success-btn"
            onclick={() => onstagelines(item.path, item.hunkIdx)}
          >Stage Lines ({selectedCount})</button>
        {:else}
          <!-- Whole-hunk Comment affordance (260531-l02): comment the hunk
               without selecting lines. Reuses the accent button class verbatim
               (no new color); host applies the New-side guard. -->
          {#if showInlineComments}
          <button
            class="staging-btn accent-btn"
            onclick={() => oncommenthunk(item.path, item.hunkIdx)}
          >Comment</button>
          {/if}
          <button
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            class="staging-btn danger-btn"
            onclick={() => ondiscardhunk(item.path, item.hunkIdx)}
          >Discard Hunk</button>
          <button
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            class="staging-btn success-btn"
            onclick={() => onstagehunk(item.path, item.hunkIdx)}
          >Stage Hunk</button>
        {/if}
      {:else if diffKind === 'staged'}
        {#if hasSelection}
          <!-- Staged Comment (260531-l02b): index-snapshot anchored, both sides
               resolve (no Old-side guard). Leads the cluster. -->
          {#if showInlineComments}
          <button
            class="staging-btn accent-btn"
            onclick={() => oncommentlines(item.path, item.hunkIdx)}
          >Comment ({selectedCount})</button>
          {/if}
          <button
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            class="staging-btn warning-btn"
            onclick={() => onunstagelines(item.path, item.hunkIdx)}
          >Unstage Lines ({selectedCount})</button>
        {:else}
          {#if showInlineComments}
          <button
            class="staging-btn accent-btn"
            onclick={() => oncommenthunk(item.path, item.hunkIdx)}
          >Comment</button>
          {/if}
          <button
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            class="staging-btn warning-btn"
            onclick={() => onunstagehunk(item.path, item.hunkIdx)}
          >Unstage Hunk</button>
        {/if}
      {:else if diffKind === 'commit'}
        <!-- Commit-diff Comment (260531-l02): whole-hunk when nothing is
             selected, line-scoped otherwise; both carry the isMerge guard. -->
        {#if showInlineComments}
        <button
          disabled={isMerge}
          title={isMerge ? "Diff comments aren't available on merge commits" : ""}
          class="staging-btn accent-btn"
          onclick={() => hasSelection ? oncommentlines(item.path, item.hunkIdx) : oncommenthunk(item.path, item.hunkIdx)}
        >{hasSelection ? `Comment (${selectedCount})` : 'Comment'}</button>
        {/if}
      {/if}
    </div>
  {:else if item.kind === "comment"}
    <div class="split-comment-row" style="position: sticky; left: 0; width: 100cqi;">
      {#each item.threads as c (c.id)}
        {@render threadCard(c)}
      {/each}
    </div>
  {:else if item.kind === "file-header"}
    <div
      class="split-file-header"
      style="position: sticky; left: 0; width: 100cqi;"
      role="button"
      tabindex="0"
      onclick={() => onfilecollapsetoggle(item.path)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onfilecollapsetoggle(item.path); } }}
    >
      <span class="split-file-header-caret">{item.collapsed ? '▶' : '▼'}</span>
      {item.path}
    </div>
  {:else if item.kind === "binary"}
    <div class="binary-row" style="position: sticky; left: 0; width: 100cqi;">Binary file — no diff available</div>
  {/if}
{/snippet}

<div
  class="split-view"
  style="{FIXED_ROW_HEIGHT_VARS}; --max-l: {vd.maxLeftPx}px; --max-r: {vd.maxRightPx}px;"
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
    style="{DIFF_ROW_FONT};"
  ></div>

  {#if vd.threadsToProbe.length > 0}
    <div class="comment-probe" bind:this={vd.commentProbe}>
      {#each vd.threadsToProbe as c (c.id)}
        <div class="split-comment-row" data-thread-id={c.id}>{@render threadCard(c)}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .split-view {
    position: absolute;
    inset: 0;
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

  .split-cell {
    display: flex;
    align-items: flex-start;
    padding: 0 var(--space-2);
    box-sizing: border-box;
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



  .split-gutter {
    text-align: right;
    color: var(--color-text-muted);
    padding-right: var(--space-2);
    user-select: none;
    -webkit-user-select: none;
    flex-shrink: 0;
  }

  /* Right-column gutter is the staging/selection trigger; the left gutter stays
     inert. Kept out of the text selection so multi-line copies skip line numbers. */
  .gutter-selectable {
    cursor: pointer;
  }
  .gutter-selectable:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: var(--radius);
  }

  .split-phantom {
    background: var(--color-diff-phantom-bg);
  }

  /* The hunk header's height is the declared token the row model computes
     offsets from, not whatever the button cluster happens to measure. */
  .split-hunk-header {
    background: color-mix(in oklch, var(--info) 6%, var(--bg-2));
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
    z-index: 1;
  }
  .split-hunk-header-text {
    flex: 1;
    color: color-mix(in oklch, var(--info) 70%, var(--fg-3));
    font-size: 11px;
    font-family: var(--font-mono, monospace);
  }

  /* Multi-file view only. Vertical stickiness does not survive the list — a row
     inside a translated container has no scrollport-relative flow position. */
  .split-file-header {
    background: var(--color-surface);
    box-shadow: inset 0 -1px 0 var(--color-border);
    font-size: 12px;
    font-weight: 500;
    padding: 0 var(--space-2);
    height: var(--diff-file-header-height);
    box-sizing: border-box;
    color: var(--color-text);
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .split-file-header-caret {
    font-size: 10px;
    color: var(--color-text-muted);
    width: 10px;
    display: inline-block;
  }
  .binary-row {
    height: var(--diff-binary-row-height);
    box-sizing: border-box;
    padding: var(--space-2);
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 16px;
  }

  .staging-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
    font-size: 11px;
    font-family: var(--font-sans, sans-serif);
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    cursor: pointer;
    white-space: nowrap;
  }
  .staging-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .danger-btn {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
  }

  .success-btn {
    background: var(--color-success-bg);
    border: 1px solid var(--color-success-border);
    color: var(--color-success);
  }

  .warning-btn {
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    color: var(--color-warning);
  }

  .accent-btn {
    background: var(--color-accent-bg);
    border: 1px solid var(--color-accent-border);
    color: var(--color-accent);
  }

  .hunk-highlight {
    animation: hunk-flash 0.6s ease-out;
  }
  @keyframes hunk-flash {
    0% { background-color: var(--color-hunk-flash); }
    100% { background-color: transparent; }
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
  .syn-keyword { color: var(--color-syn-keyword); }
  .syn-string { color: var(--color-syn-string); }
  .syn-comment { color: var(--color-syn-comment); }
  .syn-number { color: var(--color-syn-number); }
  .syn-type { color: var(--color-syn-type); }
  .syn-function { color: var(--color-syn-function); }
  .syn-variable { color: var(--color-syn-variable); }
  .syn-constant { color: var(--color-syn-constant); }
  .syn-operator { color: var(--color-syn-operator); }
  .syn-punctuation { color: var(--color-syn-punctuation); }
  .syn-attribute { color: var(--color-syn-attribute); }
  .syn-tag { color: var(--color-syn-tag); }
  .syn-property { color: var(--color-syn-property); }
  .syn-regex { color: var(--color-syn-regex); }
  .syn-escape { color: var(--color-syn-escape); }

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
  .diff-line:has(.gutter-selectable:hover)::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: color-mix(in oklch, var(--color-hover) 60%, transparent);
    pointer-events: none;
  }

  /* Left-edge accent on lines spanned by an inline comment. Inset box-shadow
     rather than a background tint so it doesn't fight the add/delete/context
     row backgrounds; layered over the existing 3px change-indicator border. */
  .diff-line-commented {
    box-shadow: inset 3px 0 0 0 var(--color-accent);
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
    font-size: 12px;
    color: var(--color-invisible);
  }

  /* Trailing whitespace warning */
  .trailing-ws {
    background-color: var(--color-trailing-ws-bg);
  }
  .trailing-ws::before {
    color: var(--color-trailing-ws-fg);
  }
</style>
