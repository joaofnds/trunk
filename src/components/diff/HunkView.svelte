<script lang="ts">
import { onMount } from "svelte";
import {
	buildInlineRows,
	countLines,
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
	fileDiffs: FileDiff[];
	selectedPath: string | null;
	diffKind: "unstaged" | "staged" | "commit";
	hunkOperationInFlight: boolean;
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

// Staging rebuilds the diff with the same view options the hunk was rendered
// under, so a hunk index means the same hunk on both sides and ignoring
// whitespace no longer has to block the gesture (TRUNK-73). Only an
// in-flight operation holds the buttons now.
const stagingDisabled = $derived(hunkOperationInFlight);
const stagingDisabledTitle: string | undefined = undefined;

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

		return buildInlineRows(fileDiffs, {
			content: "hunk",
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
	layout: "inline",
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

/** Scrolls to one line's own row. A line the model does not carry — an Old-side
 *  number with no new-side row, or a collapsed file — falls back to the hunk,
 *  which is where the element-based path landed for every jump. */
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

function lineColor(): string {
	return "var(--color-diff-text)";
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

{#snippet diffRow(item: DiffRow, _index: number)}
  {#if item.kind === "line"}
    {@const line = item.line}
    {@const isSelectable = line.origin !== 'Context'}
    {@const hunkKey = `${item.path}-${item.hunkIdx}`}
    {@const isSelected = selectedHunkKey === hunkKey && selectedLineIndices.has(item.lineIdx)}
    {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
    {@const hunkLines = fileDiffs.find((fd) => fd.path === item.path)?.hunks[item.hunkIdx]?.lines ?? []}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- mouseenter only continues an in-progress gutter drag (guarded by
         `dragging` in the host); the row itself is not a control. -->
    <div
      class="diff-line {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}{item.spanned ? ' diff-line-commented' : ''}"
      style="
        {DIFF_ROW_FONT};
        padding: 0 var(--space-2);
        white-space: {vd.wrapActive ? 'pre-wrap' : 'pre'};
        word-break: {vd.wrapActive ? 'break-all' : 'normal'};
        background: {lineBackground(line.origin, isSelected)};
        color: {lineColor()};
        display: flex;
        align-items: flex-start;
      "
      onmouseenter={(e) => onlineenter(item.path, item.hunkIdx, item.lineIdx, e)}
    ><!-- svelte-ignore a11y_no_noninteractive_tabindex --><span
        class="gutter-grip{isSelectable ? ' gutter-selectable' : ''}"
        style="user-select: none; -webkit-user-select: none;"
        role={isSelectable ? 'button' : undefined}
        tabindex={isSelectable ? 0 : undefined}
        onmousedown={(e) => isSelectable && onlinemousedown(item.path, item.hunkIdx, item.lineIdx, line.origin, hunkLines, e)}
        onkeydown={(e) => { if (isSelectable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onlineclick(item.path, item.hunkIdx, item.lineIdx, line.origin, hunkLines, new MouseEvent('click', { shiftKey: e.shiftKey })); } }}
      ><span class="gutter-num" style="min-width: {vd.gutterW};">{line.old_lineno ?? ''}</span><span class="gutter-num" style="min-width: {vd.gutterW};">{line.new_lineno ?? ''}</span></span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
  {:else if item.kind === "hunk-header"}
    {@const hunkKey = `${item.path}-${item.hunkIdx}`}
    {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
    <!-- The sticky declarations stay inline: jsdom reads only inline styles, so
         a scoped rule would leave the staging surface's horizontal stickiness
         with nothing pinning it. -->
    <div
      class="hunk-toolbar{flashedHunkKey === hunkKey ? ' hunk-highlight' : ''}"
      style="position: sticky; left: 0; width: 100cqi;"
    >
      <span class="hunk-header-text">{item.header}</span>
      {#if diffKind === 'unstaged'}
        {#if hasSelection}
          <!-- Working-tree Comment affordance (260531-k4j): reuses the
               commit-mode Comment button markup/styles verbatim (no new color).
               New-side scope + Old-side guard live in the host. Leads the action
               cluster (260531-l02 UX: Comment to the left of staging). -->
          {#if showInlineComments}
          <button
            class="hunk-btn hunk-btn-accent"
            onclick={() => oncommentlines(item.path, item.hunkIdx)}
          >
            Comment ({selectedCount})
          </button>
          {/if}
          <button
            class="hunk-btn hunk-btn-danger"
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            onclick={() => ondiscardlines(item.path, item.hunkIdx)}
          >
            Discard Lines ({selectedCount})
          </button>
          <button
            class="hunk-btn hunk-btn-success"
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            onclick={() => onstagelines(item.path, item.hunkIdx)}
          >
            Stage Lines ({selectedCount})
          </button>
        {:else}
          <!-- Whole-hunk Comment affordance (260531-l02): comment the hunk
               without selecting lines. Reuses the line-level accent button
               markup verbatim (no new color); host synthesizes the full-hunk
               selection + applies the New-side guard. Leads the action cluster. -->
          {#if showInlineComments}
          <button
            class="hunk-btn hunk-btn-accent"
            onclick={() => oncommenthunk(item.path, item.hunkIdx)}
          >
            Comment
          </button>
          {/if}
          <button
            class="hunk-btn hunk-btn-danger"
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            onclick={() => ondiscardhunk(item.path, item.hunkIdx)}
          >
            Discard Hunk
          </button>
          <button
            class="hunk-btn hunk-btn-success"
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            onclick={() => onstagehunk(item.path, item.hunkIdx)}
          >
            Stage Hunk
          </button>
        {/if}
      {:else if diffKind === 'staged'}
        {#if hasSelection}
          <!-- Staged Comment affordance (260531-l02b): anchors to the INDEX
               snapshot (HEAD→index) — both sides resolve, so no Old-side guard.
               Reuses the accent button; leads the cluster. -->
          {#if showInlineComments}
          <button
            class="hunk-btn hunk-btn-accent"
            onclick={() => oncommentlines(item.path, item.hunkIdx)}
          >
            Comment ({selectedCount})
          </button>
          {/if}
          <button
            class="hunk-btn hunk-btn-warning"
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            onclick={() => onunstagelines(item.path, item.hunkIdx)}
          >
            Unstage Lines ({selectedCount})
          </button>
        {:else}
          <!-- Whole-hunk staged Comment (260531-l02b): index-snapshot anchored. -->
          {#if showInlineComments}
          <button
            class="hunk-btn hunk-btn-accent"
            onclick={() => oncommenthunk(item.path, item.hunkIdx)}
          >
            Comment
          </button>
          {/if}
          <button
            class="hunk-btn hunk-btn-warning"
            disabled={stagingDisabled}
            title={stagingDisabledTitle}
            onclick={() => onunstagehunk(item.path, item.hunkIdx)}
          >
            Unstage Hunk
          </button>
        {/if}
      {:else if diffKind === 'commit'}
        {#if showInlineComments}
        <!-- Commit-diff Comment (260531-l02): whole-hunk when nothing is
             selected, line-scoped otherwise; both carry the isMerge guard. -->
        <button
          class="hunk-btn hunk-btn-accent"
          disabled={isMerge}
          title={isMerge ? "Diff comments aren't available on merge commits" : ""}
          onclick={() => hasSelection ? oncommentlines(item.path, item.hunkIdx) : oncommenthunk(item.path, item.hunkIdx)}
        >
          {hasSelection ? `Comment (${selectedCount})` : 'Comment'}
        </button>
        {/if}
      {/if}
    </div>
  {:else if item.kind === "comment"}
    <div class="inline-comment-row">
      {#each item.threads as c (c.id)}
        {@render threadCard(c)}
      {/each}
    </div>
  {:else if item.kind === "file-header"}
    <div
      class="file-header"
      style="position: sticky; left: 0; width: 100cqi;"
      role="button"
      tabindex="0"
      onclick={() => onfilecollapsetoggle(item.path)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onfilecollapsetoggle(item.path); } }}
    >
      <span class="file-header-caret">{item.collapsed ? '▶' : '▼'}</span>
      {item.path}
    </div>
  {:else if item.kind === "binary"}
    <div class="binary-row">Binary file — no diff available</div>
  {/if}
{/snippet}

<div class="hunk-view" style="{FIXED_ROW_HEIGHT_VARS}" bind:this={vd.pane}>
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
    style="{DIFF_ROW_FONT};"
  ></div>

  {#if vd.threadsToProbe.length > 0}
    <div class="comment-probe" bind:this={vd.commentProbe}>
      {#each vd.threadsToProbe as c (c.id)}
        <div class="inline-comment-row" data-thread-id={c.id}>{@render threadCard(c)}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .hunk-view {
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

  /* The staging toolbar stays put while a wide file pans horizontally, so the
     buttons never scroll out of reach. Its height is the declared token the row
     model computes offsets from, not whatever the button cluster happens to
     measure. */
  .hunk-toolbar {
    background: color-mix(in oklch, var(--info) 6%, var(--bg-2));
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
    height: var(--diff-hunk-header-height);
    box-shadow: inset 0 -1px 0 var(--color-border);
    box-sizing: border-box;
    z-index: 1;
  }
  .hunk-header-text {
    flex: 1;
    color: color-mix(in oklch, var(--info) 70%, var(--fg-3));
    font-size: 11px;
    font-family: var(--font-mono, monospace);
  }
  .hunk-btn {
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
  .hunk-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .hunk-btn-accent {
    background: var(--color-accent-bg, var(--color-surface));
    border: 1px solid var(--color-accent-border);
    color: var(--color-accent);
  }
  .hunk-btn-danger {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
  }
  .hunk-btn-success {
    background: var(--color-success-bg);
    border: 1px solid var(--color-success-border);
    color: var(--color-success);
  }
  .hunk-btn-warning {
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    color: var(--color-warning);
  }

  /* Multi-file view only. Vertical stickiness does not survive the list — a row
     inside a translated container has no scrollport-relative flow position — and
     is not restored here. */
  .file-header {
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
  .file-header-caret {
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

  /* Syntax highlighting classes -- text color from CSS custom properties (per D-03) */
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

  /* Gutter grip: the line-number column is the staging/selection trigger. Kept
     out of the text selection so multi-line copies never pick up line numbers. */
  .gutter-grip {
    display: inline-flex;
    flex-shrink: 0;
  }
  .gutter-num {
    text-align: right;
    color: var(--color-text-muted);
    padding-right: var(--space-2);
  }
  .gutter-selectable {
    cursor: pointer;
  }
  .gutter-selectable:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: var(--radius);
  }

  /* Faint full-row tint while hovering a selectable gutter — the affordance that
     the line number, not the code, arms staging. Painted as a z-index:-1 overlay
     so it tints over the inline diff background without hiding it. */
  .diff-line:has(.gutter-selectable:hover)::after {
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
  /* Left-edge accent on lines spanned by an inline comment. Inset box-shadow
     rather than a background tint so it doesn't fight the add/delete/context
     row backgrounds; layered over the existing 3px change-indicator border. */
  .diff-line-commented {
    box-shadow: inset 3px 0 0 0 var(--color-accent);
  }

  /* Inline comment row: a plain full-width block sibling stacked under its line
     (not a grid cell). Cards span the diff body width. */
  .inline-comment-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    width: 100cqi;
    box-sizing: border-box;
  }

  /* Invisible character styling (Phase 63 -- WHSP-03, D-11). The real whitespace
     stays in the text node (so it copies faithfully) but is given zero width via
     font-size:0; the ·/→ glyph is painted by a pseudo-element, which is never part
     of the selection/clipboard. font-size:0 also keeps a real tab at a single
     visual cell instead of advancing to a tab stop. */
  .invisible-char {
    font-size: 0;
  }
  .invisible-char::before {
    content: attr(data-glyph);
    font-size: 12px;
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
</style>
