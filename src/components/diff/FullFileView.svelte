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
import type { DiffLine, FileDiff, Thread } from "../../lib/types.js";
import ThreadCard from "../ThreadCard.svelte";
import ExactVirtualList from "./ExactVirtualList.svelte";

interface Props {
	fileDiffs: FileDiff[];
	showInvisibles: boolean;
	wordWrap: boolean;
	commitOid: string;
	repoPath: string;
	diffKind: "unstaged" | "staged" | "commit";
	isMerge: boolean;
	// Bubbles the chosen file path + the flat selected indices (into the file's
	// hunks.flatMap(h => h.lines)) up to the DiffPanel host when the user clicks
	// the Comment affordance.
	oncommentfullfile: (filePath: string, selectedIndices: Set<number>) => void;
	showInlineComments?: boolean;
	viewComments?: Thread[];
}

let {
	fileDiffs,
	showInvisibles,
	wordWrap,
	repoPath = "",
	diffKind,
	isMerge,
	oncommentfullfile,
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

// Net-new contiguous selection state (D-01): a click sets a single-line anchor;
// shift-click extends the focus, and the selected span is the inclusive range
// anchorIndex..focusIndex over the active file's flat line list. Only new-side
// lines (new_lineno != null) are valid endpoints (D-02). Scoped to one file at a
// time via selectedPath.
let selectedPath = $state<string | null>(null);
let anchorIndex = $state<number | null>(null);
let focusIndex = $state<number | null>(null);

// A press arms the span and holds it open; the pointer crossing another row
// carries the focus with it. Not a second selection model — a drag is the
// contiguous span with a moving endpoint, which is what shift-click already is.
let dragging = false;

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

// The contiguous span as flat indices into the active file's line list.
const selectedIndices = $derived(computeSpan(anchorIndex, focusIndex));

const model = $derived(
	measure("diff.buildRows", (observation) => {
		observation.attr("lines", countLines(fileDiffs));

		return buildInlineRows(fileDiffs, {
			content: "full",
			comments: viewComments,
			showInlineComments,
			collapsed: new Set<string>(),
			fileHeaders: false,
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
// measuring one would make the extent jump while scrolling (invariant 2). In
// pixels rather than `ch`, because the content div sits outside the rows and
// would resolve `ch` against the app font instead of the diff row's.
const contentWidth = $derived(
	wrapActive || !metrics
		? "100%"
		: `${(2 * model.gutterChars + (model.columns[0] ?? 0)) * metrics.charWidthPx + ROW_CHROME_PX}px`,
);

const affordanceVisible = $derived(
	(diffKind === "commit" || diffKind === "unstaged") &&
		selectedPath !== null &&
		selectedIndices.size > 0,
);

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
	const stopDrag = () => {
		dragging = false;
	};

	window.addEventListener("mouseup", stopDrag);
	return () => window.removeEventListener("mouseup", stopDrag);
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
		return;
	}

	selectedPath = path;
	anchorIndex = index;
	focusIndex = index;
}

function startDrag(path: string, line: DiffLine, index: number, e: MouseEvent) {
	// Suppress the webview's own text selection for the whole gesture: a drag
	// crosses gutters and code spans that are otherwise user-selectable, and
	// without this the browser paints its selection over ours.
	e.preventDefault();

	selectLine(path, line, index, e.shiftKey);
	dragging = true;
}

// The e.buttons guard makes a stuck `dragging` flag inert: with no button held
// there is no gesture to continue, whatever the flag says.
function extendDrag(
	path: string,
	line: DiffLine,
	index: number,
	e: MouseEvent,
) {
	if (!dragging) return;

	if (e.buttons !== 1) {
		dragging = false;
		return;
	}

	// D-02 again: a Delete line is not a valid endpoint, so the span stops at
	// the last new-side row the pointer crossed rather than snapping to it.
	if (path !== selectedPath || line.new_lineno === null) return;

	focusIndex = index;
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
    {@const isSelectable = line.new_lineno !== null}
    {@const isSelected = selectedPath === item.path && selectedIndices.has(item.flatIdx)}
    {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
    {@const gutterW = `${model.gutterChars}ch`}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- mouseenter only continues an in-progress gutter drag; the row itself is
         not a control. -->
    <div
      class="diff-line {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}{item.spanned ? ' diff-line-commented' : ''}"
      style="
        {DIFF_ROW_FONT};
        padding: 0 var(--space-2);
        white-space: {wrapActive ? 'pre-wrap' : 'pre'};
        word-break: {wrapActive ? 'break-all' : 'normal'};
        background: {lineBackground(line.origin, isSelected)};
        color: {lineColor()};
        display: flex;
        align-items: flex-start;
      "
      onmouseenter={(e) => extendDrag(item.path, line, item.flatIdx, e)}
    ><!-- svelte-ignore a11y_no_noninteractive_tabindex --><span
        class="gutter-grip{isSelectable ? ' gutter-selectable' : ''}"
        style="user-select: none; -webkit-user-select: none;"
        role={isSelectable ? 'button' : undefined}
        tabindex={isSelectable ? 0 : undefined}
        onmousedown={(e) => isSelectable && startDrag(item.path, line, item.flatIdx, e)}
        onclick={(e) => isSelectable && selectLine(item.path, line, item.flatIdx, e.shiftKey)}
        onkeydown={(e) => { if (isSelectable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectLine(item.path, line, item.flatIdx, e.shiftKey); } }}
      ><span class="gutter-num" style="min-width: {gutterW};">{line.old_lineno ?? ''}</span><span class="gutter-num" style="min-width: {gutterW};">{line.new_lineno ?? ''}</span></span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
  {:else if item.kind === "comment"}
    {#each item.threads as c (c.id)}
      <div class="comment-row">{@render threadCard(c)}</div>
    {/each}
  {:else if item.kind === "binary"}
    <div class="binary-row">Binary file — no diff available</div>
  {/if}
{/snippet}

<div class="full-file" style="{FIXED_ROW_HEIGHT_VARS}">
  {#if affordanceVisible}
    <!-- Full-file Comment affordance (L-05: no isMerge disable). Appears for
         commit diffs and unstaged working-tree diffs (260531-k4j) once a
         selection exists. Lives outside the list because it follows the live
         selection, which the row model must not take as an input. -->
    <div style="display: flex; justify-content: flex-end; padding: var(--space-1) var(--space-2); flex: 0 0 auto;">
      <button
        style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--color-accent-bg, var(--color-surface));
          border: 1px solid var(--color-border);
          border-radius: var(--radius);
          color: var(--color-accent);
          font-size: 11px;
          font-family: var(--font-sans, sans-serif);
          height: var(--control-sm-h);
          padding: 0 var(--space-2);
          cursor: pointer;
          white-space: nowrap;
        "
        onclick={() => selectedPath && oncommentfullfile(selectedPath, selectedIndices)}
      >
        Comment ({selectedIndices.size})
      </button>
    </div>
  {/if}

  <div class="list-area" bind:this={pane}>
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
          <div class="comment-row" data-thread-id={c.id}>{@render threadCard(c)}</div>
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
    font-size: 12px;
    line-height: 16px;
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

  /* Gutter grip: the line-number column is the selection trigger. Kept out of the
     text selection so copies never pick up line numbers. */
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
    border-radius: var(--radius);
  }

  /* Faint full-row tint while hovering a selectable gutter — signals the line
     number arms selection, not the code. z-index:-1 overlay so it tints over the
     inline diff background without hiding it. */
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
  /* Inline-comment gutter accent: a left-edge inset rail in the accent color,
     layered via box-shadow so it never tints the diff add/delete/context
     background and never overrides the per-origin change-indicator border. */
  .diff-line-commented {
    box-shadow: inset 2px 0 0 0 var(--color-accent);
  }

  /* Comment rows hang as full-width block siblings directly under their anchored
     line, indented to clear the change-indicator rail. */
  .comment-row {
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-4);
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
