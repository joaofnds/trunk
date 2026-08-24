<script lang="ts">
import { onMount, tick } from "svelte";
import {
	buildInlineRows,
	type DiffRow,
	FIXED_ROW_HEIGHT_VARS,
	rowHeights,
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
import {
	availableCharsFor,
	DIFF_ROW_FONT,
	measureRowMetrics,
	type RowMetrics,
} from "../../lib/row-metrics.js";
import type {
	DiffLine,
	DiffOrigin,
	FileDiff,
	Thread,
} from "../../lib/types.js";
import ThreadCard from "../ThreadCard.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";

interface Props {
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

// Tailwind's preflight sets tab-size: 4 globally, so a tab advances four
// columns — unless invisibles are on, where .invisible-char collapses it to one.
const TAB_SIZE = 4;

// Horizontal room a row spends on something other than columns: 8px padding
// each side, the 3px change-indicator border, and the 8px gap after each of the
// two gutters. Erring high shortens the wrap point, which over-predicts a
// wrapped row's height — the safe direction.
const ROW_CHROME_PX = 35;

const stagingDisabled = $derived(hunkOperationInFlight || ignoreWhitespace);
const stagingDisabledTitle = $derived(
	ignoreWhitespace
		? "Staging is disabled while whitespace changes are ignored"
		: undefined,
);

let pane = $state<HTMLDivElement | null>(null);
let metricsProbe = $state<HTMLDivElement | null>(null);
let commentProbe = $state<HTMLDivElement | null>(null);
let metrics = $state<RowMetrics | null>(null);
let paneWidthPx = $state(0);
let probedHeights = $state(new Map<string, number>());
let list = $state<{
	topIndex: () => number;
	anchorTo: (index: number) => void;
} | null>(null);

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

// A proportional font makes column arithmetic meaningless, so wrapping is
// refused rather than rendered at a height nothing can derive (P-8).
const wrapActive = $derived(wordWrap && (metrics?.monospace ?? false));

const availableColumns = $derived(
	metrics
		? availableCharsFor(
				paneWidthPx,
				2 * model.gutterChars,
				ROW_CHROME_PX,
				metrics,
			)
		: 0,
);

const threadsToProbe = $derived(
	model.rows.flatMap((row) => (row.kind === "comment" ? row.threads : [])),
);

// Invariant 8: withhold the list until every input exists, rather than render
// against a default height and correct it afterwards.
const ready = $derived(
	metrics !== null &&
		paneWidthPx > 0 &&
		threadsToProbe.every((thread) => probedHeights.has(thread.id)) &&
		(!wrapActive || availableColumns > 0),
);

const heights = $derived.by(() => {
	const measured = metrics;
	if (!ready || !measured) return [];

	return measure("diff.rowHeights", (observation) => {
		observation.attr("rows", model.rows.length);
		observation.attr("wrap", String(wrapActive));

		return rowHeights(
			model,
			measured,
			availableColumns,
			wrapActive,
			probedHeights,
		);
	});
});

// Computed, never measured: a virtual list never has the widest row mounted, so
// measuring one would make the extent jump while scrolling (invariant 2).
const contentWidth = $derived(
	wrapActive || !metrics
		? "100%"
		: `${(2 * model.gutterChars + (model.columns[0] ?? 0)) * metrics.charWidthPx + ROW_CHROME_PX}px`,
);

const gutterW = $derived(`${model.gutterChars}ch`);

onMount(() => {
	if (metricsProbe) metrics = measureRowMetrics(metricsProbe);

	const el = pane;
	if (!el) return;

	paneWidthPx = el.clientWidth;

	const observer = new ResizeObserver(() => {
		const anchor = list?.topIndex() ?? 0;
		paneWidthPx = el.clientWidth;

		if (wrapActive) tick().then(() => list?.anchorTo(anchor));
	});
	observer.observe(el);

	return () => observer.disconnect();
});

$effect(() => {
	const container = commentProbe;
	const wanted = threadsToProbe;
	if (!container || wanted.length === 0) return;

	// Lay the probe out at the width the real rows occupy, and re-measure
	// whenever that width changes: a ThreadCard reflows, so a height taken at
	// another width is not this row's height (P-2's re-probe triggers).
	container.style.width = contentWidth;
	container.style.minWidth = `${paneWidthPx}px`;

	const measured = new Map<string, number>();
	for (const row of container.querySelectorAll<HTMLElement>(
		"[data-thread-id]",
	)) {
		const id = row.dataset.threadId;
		const height = row.offsetHeight;
		// A zero here is an unmeasured row, not a row of no height. Recording it
		// would be the substituted default invariant 8 forbids.
		if (id && height > 0) measured.set(id, height);
	}

	if (wanted.every((thread) => measured.has(thread.id))) {
		probedHeights = measured;
	}
});

function countLines(diffs: FileDiff[]): number {
	let total = 0;
	for (const fd of diffs) {
		for (const hunk of fd.hunks) total += hunk.lines.length;
	}
	return total;
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
        padding: 0 8px;
        white-space: {wrapActive ? 'pre-wrap' : 'pre'};
        word-break: {wrapActive ? 'break-all' : 'normal'};
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
      ><span class="gutter-num" style="min-width: {gutterW};">{line.old_lineno ?? ''}</span><span class="gutter-num" style="min-width: {gutterW};">{line.new_lineno ?? ''}</span></span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
  {:else if item.kind === "hunk-header"}
    {@const hunkKey = `${item.path}-${item.hunkIdx}`}
    {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
    <!-- The sticky declarations stay inline: jsdom reads only inline styles, so
         a scoped rule would leave the staging surface's horizontal stickiness
         with nothing pinning it. -->
    <div
      class="hunk-toolbar"
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

<div class="hunk-view" style="{FIXED_ROW_HEIGHT_VARS}" bind:this={pane}>
  {#if ready}
    <ExactVirtualList
      bind:this={list}
      items={model.rows}
      {heights}
      {contentWidth}
      renderItem={diffRow}
    />
  {/if}

  <div
    class="diff-line metrics-probe"
    bind:this={metricsProbe}
    style="{DIFF_ROW_FONT};"
  ></div>

  {#if threadsToProbe.length > 0}
    <div class="comment-probe" bind:this={commentProbe}>
      {#each threadsToProbe as c (c.id)}
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
    gap: 8px;
    padding: 0 8px;
    height: var(--diff-hunk-header-height);
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
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--font-sans, sans-serif);
    padding: 2px 8px;
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
    border-bottom: 1px solid var(--color-border);
    font-size: 12px;
    font-weight: 500;
    padding: 0 8px;
    height: var(--diff-file-header-height);
    box-sizing: border-box;
    color: var(--color-text);
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 4px;
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
    padding: 8px;
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
    border-radius: 2px;
  }
  .word-delete {
    background-color: var(--color-diff-word-delete-bg);
    border-radius: 2px;
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
    padding-right: 8px;
  }
  .gutter-selectable {
    cursor: pointer;
  }
  .gutter-selectable:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: 2px;
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
    gap: 6px;
    padding: 6px 8px 6px 11px;
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
</style>
