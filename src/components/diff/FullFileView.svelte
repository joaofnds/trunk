<script lang="ts">
import {
	commentsForLine,
	spannedByComment,
} from "../../lib/comment-matching.js";
import {
	splitInvisibles,
	trailingWhitespaceStart,
} from "../../lib/diff-utils.js";
import {
	addReply,
	deleteComment,
	deleteReply,
	editComment,
	editReply,
	setThreadState,
} from "../../lib/review-comment-actions.js";
import type { DiffLine, FileDiff, Thread } from "../../lib/types.js";
import ThreadCard from "../ThreadCard.svelte";

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

// Net-new contiguous selection state (D-01): a click sets a single-line anchor;
// shift-click extends the focus, and the selected span is the inclusive range
// anchorIndex..focusIndex over the active file's flat line list. Only new-side
// lines (new_lineno != null) are valid endpoints (D-02). Scoped to one file at a
// time via selectedPath.
let selectedPath = $state<string | null>(null);
let anchorIndex = $state<number | null>(null);
let focusIndex = $state<number | null>(null);

// The contiguous span as flat indices into the active file's line list.
const selectedIndices = $derived(computeSpan(anchorIndex, focusIndex));

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
	lines: DiffLine[],
	index: number,
	shift: boolean,
) {
	// D-02: only new-side lines are valid selection endpoints. A click on a Delete
	// line (new_lineno === null) is a no-op.
	if (lines[index].new_lineno === null) return;

	if (shift && selectedPath === path && anchorIndex !== null) {
		focusIndex = index;
		return;
	}

	selectedPath = path;
	anchorIndex = index;
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

function maxLineNumber(fd: FileDiff): number {
	let max = 0;
	for (const hunk of fd.hunks) {
		for (const line of hunk.lines) {
			if (line.old_lineno !== null && line.old_lineno > max)
				max = line.old_lineno;
			if (line.new_lineno !== null && line.new_lineno > max)
				max = line.new_lineno;
		}
	}
	return max;
}

function gutterWidth(maxNum: number): string {
	const digits = Math.max(String(maxNum).length, 1);
	return `${digits + 1}ch`;
}
</script>

{#each fileDiffs as fd (fd.path)}
  {@const gutterW = gutterWidth(maxLineNumber(fd))}
  {@const allLines = fd.hunks.flatMap(h => h.lines)}
  {@const fileSelected = selectedPath === fd.path && selectedIndices.size > 0}
  <div style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};">
    {#if fd.is_binary}
      <div style="
        padding: 8px;
        color: var(--color-text-muted);
        font-size: 12px;
      ">
        Binary file — no diff available
      </div>
    {:else}
      <!-- Full-file Comment affordance (L-05: no isMerge disable). Appears for
           commit diffs and unstaged working-tree diffs (260531-k4j) once a
           selection exists. Full-file is always New-side (buildFullFileAnchor) so
           no Old-side guard is needed for the unstaged case. -->
      {#if (diffKind === 'commit' || diffKind === 'unstaged') && fileSelected}
        <div style="display: flex; justify-content: flex-end; padding: 4px 8px;">
          <button
            style="
              background: var(--color-accent-bg, var(--color-surface));
              border: 1px solid var(--color-border);
              border-radius: 3px;
              color: var(--color-accent);
              font-size: 11px;
              font-family: var(--font-sans, sans-serif);
              padding: 2px 8px;
              cursor: pointer;
              white-space: nowrap;
            "
            onclick={() => oncommentfullfile(fd.path, selectedIndices)}
          >
            Comment ({selectedIndices.size})
          </button>
        </div>
      {/if}
      {#each allLines as line, lineIdx}
        {@const isSelectable = line.new_lineno !== null}
        {@const isSelected = selectedPath === fd.path && selectedIndices.has(lineIdx)}
        {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
        {@const lineComments = showInlineComments ? [...commentsForLine(viewComments, 'New', line.new_lineno), ...commentsForLine(viewComments, 'Old', line.old_lineno)] : []}
        {@const spanned = showInlineComments && (spannedByComment(viewComments, 'New', line.new_lineno) || spannedByComment(viewComments, 'Old', line.old_lineno))}
        <div
          class="diff-line {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}{spanned ? ' diff-line-commented' : ''}"
          style="
            font-family: monospace;
            font-size: 12px;
            line-height: 1.5;
            padding: 0 8px;
            white-space: {wordWrap ? 'pre-wrap' : 'pre'};
            background: {lineBackground(line.origin, isSelected)};
            color: {lineColor()};
            display: flex;
            align-items: flex-start;
          "
        ><!-- svelte-ignore a11y_no_noninteractive_tabindex --><span
            class="gutter-grip{isSelectable ? ' gutter-selectable' : ''}"
            style="user-select: none; -webkit-user-select: none;"
            role={isSelectable ? 'button' : undefined}
            tabindex={isSelectable ? 0 : undefined}
            onmousedown={(e) => { if (isSelectable && e.shiftKey) e.preventDefault(); }}
            onclick={(e) => isSelectable && selectLine(fd.path, allLines, lineIdx, e.shiftKey)}
            onkeydown={(e) => { if (isSelectable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectLine(fd.path, allLines, lineIdx, e.shiftKey); } }}
          ><span class="gutter-num" style="min-width: {gutterW};">{line.old_lineno ?? ''}</span><span class="gutter-num" style="min-width: {gutterW};">{line.new_lineno ?? ''}</span></span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
        {#if showInlineComments}
          {#each lineComments as c (c.id)}
            <div class="comment-row">
              <ThreadCard
                variant="inline"
                confirmDelete={false}
                comment={c}
                onedit={(id, text) => editComment(repoPath, id, text)}
                onreply={(id, text) => addReply(repoPath, id, text)}
                onstatechange={(id, next) => setThreadState(repoPath, id, next)}
                onreplyedit={(id, text) => editReply(repoPath, id, text)}
                ondeletereply={(id) => deleteReply(repoPath, id)}
                ondelete={(id) => deleteComment(repoPath, id)}
              />
            </div>
          {/each}
        {/if}
      {/each}
    {/if}
  </div>
{/each}

<style>
  .word-add {
    background-color: var(--color-diff-word-add-bg);
    border-radius: 2px;
  }
  .word-delete {
    background-color: var(--color-diff-word-delete-bg);
    border-radius: 2px;
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
    border-radius: 2px;
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
    padding: 4px 8px 4px 16px;
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
