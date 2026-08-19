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
import type {
	DiffLine,
	DiffOrigin,
	FileDiff,
	Thread,
} from "../../lib/types.js";
import ThreadCard from "../ThreadCard.svelte";

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
	hunkElements: Record<string, HTMLDivElement>;
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
	hunkElements,
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

const stagingDisabled = $derived(hunkOperationInFlight || ignoreWhitespace);
const stagingDisabledTitle = $derived(
	ignoreWhitespace
		? "Staging is disabled while whitespace changes are ignored"
		: undefined,
);

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
  <div style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};">
    <!-- File header bar (hidden for single-file view since top bar shows the path) -->
    {#if !selectedPath}
      <div
        role="button"
        tabindex="0"
        style="
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        font-size: 12px;
        font-weight: 500;
        padding: 4px 8px;
        color: var(--color-text);
        position: sticky;
        top: 0;
        left: 0;
        z-index: 2;
        width: 100cqi;
        box-sizing: border-box;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 4px;
      "
        onclick={() => onfilecollapsetoggle(fd.path)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onfilecollapsetoggle(fd.path); } }}
      >
        <span style="font-size: 10px; color: var(--color-text-muted); width: 10px; display: inline-block;">{collapsedFiles.has(fd.path) ? '▶' : '▼'}</span>
        {fd.path}
      </div>
    {/if}

    {#if !collapsedFiles.has(fd.path)}
    {#if fd.is_binary}
      <!-- Binary file fallback -->
      <div style="
        padding: 8px;
        color: var(--color-text-muted);
        font-size: 12px;
      ">
        Binary file — no diff available
      </div>
    {:else}
      <!-- Hunks -->
      {#each fd.hunks as hunk, hunkIdx}
        <!-- Hunk toolbar row -->
        <div
          bind:this={hunkElements[`${fd.path}-${hunkIdx}`]}
          style="
            background: color-mix(in oklch, var(--info) 6%, var(--bg-2));
            display: flex;
            align-items: center;
            padding: 4px 8px;
            gap: 8px;
            position: sticky;
            left: 0;
            z-index: 1;
            width: 100cqi;
            box-sizing: border-box;
          "
        >
          <span style="flex: 1; color: color-mix(in oklch, var(--info) 70%, var(--fg-3)); font-size: 11px; font-family: var(--font-mono, monospace);">
            {hunk.header}
          </span>
          {#if diffKind === 'unstaged'}
            {@const hunkKey = `${fd.path}-${hunkIdx}`}
            {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
            {#if hasSelection}
              <!-- Working-tree Comment affordance (260531-k4j): reuses the
                   commit-mode Comment button markup/styles verbatim (no new color).
                   New-side scope + Old-side guard live in the host. Leads the action
                   cluster (260531-l02 UX: Comment to the left of staging). -->
              {#if showInlineComments}
              <button
                style="
                  background: var(--color-accent-bg, var(--color-surface));
                  border: 1px solid var(--color-accent-border);
                  border-radius: 3px;
                  color: var(--color-accent);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: pointer;
                  white-space: nowrap;
                "
                onclick={() => oncommentlines(fd.path, hunkIdx)}
              >
                Comment ({selectedCount})
              </button>
              {/if}
              <button
                disabled={stagingDisabled}
              title={stagingDisabledTitle}
                style="
                  background: var(--color-danger-bg);
                  border: 1px solid var(--color-danger-border);
                  border-radius: 3px;
                  color: var(--color-danger);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {stagingDisabled ? 'not-allowed' : 'pointer'};
                  opacity: {stagingDisabled ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => ondiscardlines(fd.path, hunkIdx)}
              >
                Discard Lines ({selectedCount})
              </button>
              <button
                disabled={stagingDisabled}
              title={stagingDisabledTitle}
                style="
                  background: var(--color-success-bg);
                  border: 1px solid var(--color-success-border);
                  border-radius: 3px;
                  color: var(--color-success);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {stagingDisabled ? 'not-allowed' : 'pointer'};
                  opacity: {stagingDisabled ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => onstagelines(fd.path, hunkIdx)}
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
                style="
                  background: var(--color-accent-bg, var(--color-surface));
                  border: 1px solid var(--color-accent-border);
                  border-radius: 3px;
                  color: var(--color-accent);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: pointer;
                  white-space: nowrap;
                "
                onclick={() => oncommenthunk(fd.path, hunkIdx)}
              >
                Comment
              </button>
              {/if}
              <button
                disabled={stagingDisabled}
              title={stagingDisabledTitle}
                style="
                  background: var(--color-danger-bg);
                  border: 1px solid var(--color-danger-border);
                  border-radius: 3px;
                  color: var(--color-danger);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {stagingDisabled ? 'not-allowed' : 'pointer'};
                  opacity: {stagingDisabled ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => ondiscardhunk(fd.path, hunkIdx)}
              >
                Discard Hunk
              </button>
              <button
                disabled={stagingDisabled}
              title={stagingDisabledTitle}
                style="
                  background: var(--color-success-bg);
                  border: 1px solid var(--color-success-border);
                  border-radius: 3px;
                  color: var(--color-success);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {stagingDisabled ? 'not-allowed' : 'pointer'};
                  opacity: {stagingDisabled ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => onstagehunk(fd.path, hunkIdx)}
              >
                Stage Hunk
              </button>
            {/if}
          {:else if diffKind === 'staged'}
            {@const hunkKey = `${fd.path}-${hunkIdx}`}
            {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
            {#if hasSelection}
              <!-- Staged Comment affordance (260531-l02b): anchors to the INDEX
                   snapshot (HEAD→index) — both sides resolve, so no Old-side guard.
                   Reuses the accent button; leads the cluster. -->
              {#if showInlineComments}
              <button
                style="
                  background: var(--color-accent-bg, var(--color-surface));
                  border: 1px solid var(--color-accent-border);
                  border-radius: 3px;
                  color: var(--color-accent);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: pointer;
                  white-space: nowrap;
                "
                onclick={() => oncommentlines(fd.path, hunkIdx)}
              >
                Comment ({selectedCount})
              </button>
              {/if}
              <button
                disabled={stagingDisabled}
              title={stagingDisabledTitle}
                style="
                  background: var(--color-warning-bg);
                  border: 1px solid var(--color-warning-border);
                  border-radius: 3px;
                  color: var(--color-warning);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {stagingDisabled ? 'not-allowed' : 'pointer'};
                  opacity: {stagingDisabled ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => onunstagelines(fd.path, hunkIdx)}
              >
                Unstage Lines ({selectedCount})
              </button>
            {:else}
              <!-- Whole-hunk staged Comment (260531-l02b): index-snapshot anchored. -->
              {#if showInlineComments}
              <button
                style="
                  background: var(--color-accent-bg, var(--color-surface));
                  border: 1px solid var(--color-accent-border);
                  border-radius: 3px;
                  color: var(--color-accent);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: pointer;
                  white-space: nowrap;
                "
                onclick={() => oncommenthunk(fd.path, hunkIdx)}
              >
                Comment
              </button>
              {/if}
              <button
                disabled={stagingDisabled}
              title={stagingDisabledTitle}
                style="
                  background: var(--color-warning-bg);
                  border: 1px solid var(--color-warning-border);
                  border-radius: 3px;
                  color: var(--color-warning);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {stagingDisabled ? 'not-allowed' : 'pointer'};
                  opacity: {stagingDisabled ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => onunstagehunk(fd.path, hunkIdx)}
              >
                Unstage Hunk
              </button>
            {/if}
          {:else if diffKind === 'commit'}
            {@const hunkKey = `${fd.path}-${hunkIdx}`}
            {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
            {#if hasSelection}
              {#if showInlineComments}
              <button
                disabled={isMerge}
                title={isMerge ? "Diff comments aren't available on merge commits" : ""}
                style="
                  background: var(--color-accent-bg, var(--color-surface));
                  border: 1px solid var(--color-accent-border);
                  border-radius: 3px;
                  color: var(--color-accent);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {isMerge ? 'not-allowed' : 'pointer'};
                  opacity: {isMerge ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => oncommentlines(fd.path, hunkIdx)}
              >
                Comment ({selectedCount})
              </button>
              {/if}
            {:else}
              <!-- Whole-hunk Comment in commit diffs (260531-l02): same accent
                   button + isMerge disable guard as the line-level commit Comment. -->
              {#if showInlineComments}
              <button
                disabled={isMerge}
                title={isMerge ? "Diff comments aren't available on merge commits" : ""}
                style="
                  background: var(--color-accent-bg, var(--color-surface));
                  border: 1px solid var(--color-accent-border);
                  border-radius: 3px;
                  color: var(--color-accent);
                  font-size: 11px;
                  font-family: var(--font-sans, sans-serif);
                  padding: 2px 8px;
                  cursor: {isMerge ? 'not-allowed' : 'pointer'};
                  opacity: {isMerge ? 0.4 : 1};
                  white-space: nowrap;
                "
                onclick={() => oncommenthunk(fd.path, hunkIdx)}
              >
                Comment
              </button>
              {/if}
            {/if}
          {/if}
        </div>

        <!-- Diff lines -->
        {#each hunk.lines as line, lineIdx}
          {@const isSelectable = line.origin !== 'Context'}
          {@const hunkKey = `${fd.path}-${hunkIdx}`}
          {@const isSelected = selectedHunkKey === hunkKey && selectedLineIndices.has(lineIdx)}
          {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
          {@const lineComments = showInlineComments ? [...commentsForLine(viewComments, 'New', line.new_lineno), ...commentsForLine(viewComments, 'Old', line.old_lineno)] : []}
          {@const isSpanned = showInlineComments && (spannedByComment(viewComments, 'New', line.new_lineno) || spannedByComment(viewComments, 'Old', line.old_lineno))}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- mouseenter only continues an in-progress gutter drag (guarded by
               `dragging` in the host); the row itself is not a control. -->
          <div
            class="diff-line {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}{isSpanned ? ' diff-line-commented' : ''}"
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
            onmouseenter={(e) => onlineenter(fd.path, hunkIdx, lineIdx, e)}
          ><!-- svelte-ignore a11y_no_noninteractive_tabindex --><span
              class="gutter-grip{isSelectable ? ' gutter-selectable' : ''}"
              style="user-select: none; -webkit-user-select: none;"
              role={isSelectable ? 'button' : undefined}
              tabindex={isSelectable ? 0 : undefined}
              onmousedown={(e) => isSelectable && onlinemousedown(fd.path, hunkIdx, lineIdx, line.origin, hunk.lines, e)}
              onkeydown={(e) => { if (isSelectable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onlineclick(fd.path, hunkIdx, lineIdx, line.origin, hunk.lines, new MouseEvent('click', { shiftKey: e.shiftKey })); } }}
            ><span class="gutter-num" style="min-width: {gutterW};">{line.old_lineno ?? ''}</span><span class="gutter-num" style="min-width: {gutterW};">{line.new_lineno ?? ''}</span></span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
          {#if lineComments.length > 0}
            <div class="inline-comment-row">
              {#each lineComments as c (c.id)}
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
              {/each}
            </div>
          {/if}
        {/each}
      {/each}
    {/if}
    {/if}
  </div>
{/each}

<style>
  :global(.hunk-highlight) {
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
