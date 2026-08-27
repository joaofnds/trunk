<script lang="ts">
import {
	commentsForLine,
	spannedByComment,
} from "../../lib/comment-matching.js";
import {
	type PairedRow,
	pairLines,
	splitInvisibles,
	trailingWhitespaceStart,
} from "../../lib/diff-utils.js";
import {
	addReply,
	deleteReply,
	deleteThread,
	editReply,
	editThread,
	setThreadState,
} from "../../lib/review-comment-actions.js";
import { createHorizontalScrollSync } from "../../lib/scroll-sync.js";
import type {
	ContentMode,
	DiffLine,
	DiffOrigin,
	FileDiff,
	Thread,
} from "../../lib/types.js";
import ThreadCard from "../ThreadCard.svelte";

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

const splitColSync = createHorizontalScrollSync();

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

interface Section {
	type: "header" | "lines";
	header?: string;
	hunkIdx: number;
	rows: PairedRow[];
	hunkLines?: DiffLine[];
}

const pairedData = $derived(
	fileDiffs.map((fd) => {
		const maxLn = maxLineNumber(fd);
		const gw = gutterWidth(maxLn);
		if (contentMode === "full") {
			const allLines = fd.hunks.flatMap((h) => h.lines);
			return {
				fd,
				gutterW: gw,
				sections: [
					{
						type: "lines" as const,
						rows: pairLines(allLines),
						hunkIdx: 0,
						hunkLines: allLines,
					},
				] as Section[],
			};
		}
		const sections: Section[] = fd.hunks.flatMap((hunk, hunkIdx) => [
			{
				type: "header" as const,
				header: hunk.header,
				hunkIdx,
				rows: [] as PairedRow[],
				hunkLines: hunk.lines,
			},
			{
				type: "lines" as const,
				rows: pairLines(hunk.lines),
				hunkIdx,
				hunkLines: hunk.lines,
			},
		]);
		return { fd, gutterW: gw, sections };
	}),
);

// Split a hunk's row-pairs into runs broken at comment boundaries: each run is a
// two-column block, with a full-width comment row inserted after the row-pair the
// comment is anchored to. Preserves the existing column scroll-sync (every run's
// columns join the shared synced set, exactly like the per-hunk columns already do).
type SplitSegment =
	| { kind: "run"; rows: PairedRow[] }
	| { kind: "comments"; comments: Thread[] };

function rowComments(row: PairedRow, comments: Thread[]): Thread[] {
	return [
		...commentsForLine(comments, "New", row.right?.line.new_lineno ?? null),
		...commentsForLine(comments, "Old", row.left?.line.old_lineno ?? null),
	];
}

function buildSegments(
	rows: PairedRow[],
	comments: Thread[],
	show: boolean,
): SplitSegment[] {
	if (!show) return [{ kind: "run", rows }];
	const segments: SplitSegment[] = [];
	let run: PairedRow[] = [];
	for (const row of rows) {
		run.push(row);
		const cs = rowComments(row, comments);
		if (cs.length > 0) {
			segments.push({ kind: "run", rows: run });
			segments.push({ kind: "comments", comments: cs });
			run = [];
		}
	}
	if (run.length > 0) segments.push({ kind: "run", rows: run });
	return segments;
}
</script>

{#each pairedData as { fd, gutterW, sections } (fd.path)}
  <div class="split-file">
    <!-- File header bar (hidden for single-file view since top bar shows the path) -->
    {#if !selectedPath}
      <div
        role="button"
        tabindex="0"
        style="
        background: var(--color-surface);
        box-shadow: inset 0 -1px 0 var(--color-border);
        font-size: 12px;
        font-weight: 500;
        height: var(--bar-h);
        display: flex;
        align-items: center;
        padding: 0 var(--space-2);
        color: var(--color-text);
        position: sticky;
        top: 0;
        z-index: 1;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        gap: var(--space-1);
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
      <div style="
        padding: var(--space-2);
        color: var(--color-text-muted);
        font-size: 12px;
      ">
        Binary file — no diff available
      </div>
    {:else}
      {#each sections as section}
        {#if section.type === "header"}
          <!-- Hunk header spans full width -->
          <div
            bind:this={hunkElements[`${fd.path}-${section.hunkIdx}`]}
            class="split-hunk-header"
          >
            <span style="flex: 1; font-size: 11px; font-family: var(--font-mono, monospace);">
              {section.header}
            </span>
            {#if diffKind === 'unstaged'}
              {@const hunkKey = `${fd.path}-${section.hunkIdx}`}
              {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
              {#if hasSelection}
                <!-- Working-tree Comment affordance (260531-k4j): reuses the
                     commit-mode accent button class verbatim (no new color).
                     New-side scope + Old-side guard live in the host. Leads the
                     action cluster (260531-l02 UX: Comment left of staging). -->
                {#if showInlineComments}
                <button
                  class="staging-btn accent-btn"
                  style="cursor: pointer;"
                  onclick={() => oncommentlines(fd.path, section.hunkIdx)}
                >Comment ({selectedCount})</button>
                {/if}
                <button
                  disabled={stagingDisabled}
                  title={stagingDisabledTitle}
                  class="staging-btn danger-btn"
                  style="cursor: {stagingDisabled ? 'not-allowed' : 'pointer'}; opacity: {stagingDisabled ? 0.4 : 1};"
                  onclick={() => ondiscardlines(fd.path, section.hunkIdx)}
                >Discard Lines ({selectedCount})</button>
                <button
                  disabled={stagingDisabled}
                  title={stagingDisabledTitle}
                  class="staging-btn success-btn"
                  style="cursor: {stagingDisabled ? 'not-allowed' : 'pointer'}; opacity: {stagingDisabled ? 0.4 : 1};"
                  onclick={() => onstagelines(fd.path, section.hunkIdx)}
                >Stage Lines ({selectedCount})</button>
              {:else}
                <!-- Whole-hunk Comment affordance (260531-l02): comment the hunk
                     without selecting lines. Reuses the accent button class
                     verbatim (no new color); host applies the New-side guard.
                     Leads the action cluster. -->
                {#if showInlineComments}
                <button
                  class="staging-btn accent-btn"
                  style="cursor: pointer;"
                  onclick={() => oncommenthunk(fd.path, section.hunkIdx)}
                >Comment</button>
                {/if}
                <button
                  disabled={stagingDisabled}
                  title={stagingDisabledTitle}
                  class="staging-btn danger-btn"
                  style="cursor: {stagingDisabled ? 'not-allowed' : 'pointer'}; opacity: {stagingDisabled ? 0.4 : 1};"
                  onclick={() => ondiscardhunk(fd.path, section.hunkIdx)}
                >Discard Hunk</button>
                <button
                  disabled={stagingDisabled}
                  title={stagingDisabledTitle}
                  class="staging-btn success-btn"
                  style="cursor: {stagingDisabled ? 'not-allowed' : 'pointer'}; opacity: {stagingDisabled ? 0.4 : 1};"
                  onclick={() => onstagehunk(fd.path, section.hunkIdx)}
                >Stage Hunk</button>
              {/if}
            {:else if diffKind === 'staged'}
              {@const hunkKey = `${fd.path}-${section.hunkIdx}`}
              {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
              {#if hasSelection}
                <!-- Staged Comment (260531-l02b): index-snapshot anchored, both sides
                     resolve (no Old-side guard). Leads the cluster. -->
                {#if showInlineComments}
                <button
                  class="staging-btn accent-btn"
                  style="cursor: pointer;"
                  onclick={() => oncommentlines(fd.path, section.hunkIdx)}
                >Comment ({selectedCount})</button>
                {/if}
                <button
                  disabled={stagingDisabled}
                  title={stagingDisabledTitle}
                  class="staging-btn warning-btn"
                  style="cursor: {stagingDisabled ? 'not-allowed' : 'pointer'}; opacity: {stagingDisabled ? 0.4 : 1};"
                  onclick={() => onunstagelines(fd.path, section.hunkIdx)}
                >Unstage Lines ({selectedCount})</button>
              {:else}
                {#if showInlineComments}
                <button
                  class="staging-btn accent-btn"
                  style="cursor: pointer;"
                  onclick={() => oncommenthunk(fd.path, section.hunkIdx)}
                >Comment</button>
                {/if}
                <button
                  disabled={stagingDisabled}
                  title={stagingDisabledTitle}
                  class="staging-btn warning-btn"
                  style="cursor: {stagingDisabled ? 'not-allowed' : 'pointer'}; opacity: {stagingDisabled ? 0.4 : 1};"
                  onclick={() => onunstagehunk(fd.path, section.hunkIdx)}
                >Unstage Hunk</button>
              {/if}
            {:else if diffKind === 'commit'}
              {@const hunkKey = `${fd.path}-${section.hunkIdx}`}
              {@const hasSelection = selectedHunkKey === hunkKey && selectedCount > 0}
              {#if hasSelection}
                {#if showInlineComments}
                <button
                  disabled={isMerge}
                  title={isMerge ? "Diff comments aren't available on merge commits" : ""}
                  class="staging-btn accent-btn"
                  style="cursor: {isMerge ? 'not-allowed' : 'pointer'}; opacity: {isMerge ? 0.4 : 1};"
                  onclick={() => oncommentlines(fd.path, section.hunkIdx)}
                >Comment ({selectedCount})</button>
                {/if}
              {:else}
                <!-- Whole-hunk Comment in commit diffs (260531-l02): same accent
                     class + isMerge disable guard as the line-level commit Comment. -->
                {#if showInlineComments}
                <button
                  disabled={isMerge}
                  title={isMerge ? "Diff comments aren't available on merge commits" : ""}
                  class="staging-btn accent-btn"
                  style="cursor: {isMerge ? 'not-allowed' : 'pointer'}; opacity: {isMerge ? 0.4 : 1};"
                  onclick={() => oncommenthunk(fd.path, section.hunkIdx)}
                >Comment</button>
                {/if}
              {/if}
            {/if}
          </div>
        {:else}
          {@const rowSegments = buildSegments(section.rows, viewComments, showInlineComments)}
          {#each rowSegments as segment}
          {#if segment.kind === "run"}
          <div class="split-columns">
            <!-- Left column (old content) -->
            <div class="split-column" use:splitColSync>
              <div style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};">
              {#each segment.rows as row}
                {#if row.left}
                  {@const line = row.left.line}
                  {@const isSelected = selectedHunkKey === `${fd.path}-${section.hunkIdx}` && selectedLineIndices.has(row.left.lineIdx)}
                  {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
                  {@const commented = showInlineComments && spannedByComment(viewComments, 'Old', line.old_lineno)}
                  <div
                    class="diff-line {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}{commented ? ' diff-line-commented' : ''}"
                    style="
                      background: {lineBackground(line.origin, isSelected)};
                      color: {lineColor()};
                      white-space: {wordWrap ? 'pre-wrap' : 'pre'};
                    "
                  ><span class="gutter" style="min-width: {gutterW};">{line.old_lineno ?? ''}</span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
                {:else}
                  <div class="split-phantom"></div>
                {/if}
              {/each}
              </div>
            </div>
            <!-- Right column (new content) -->
            <div class="split-column" use:splitColSync>
              <div style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};">
              {#each segment.rows as row}
                {#if row.right}
                  {@const line = row.right.line}
                  {@const isSelectable = line.origin === 'Add'}
                  {@const isSelected = selectedHunkKey === `${fd.path}-${section.hunkIdx}` && selectedLineIndices.has(row.right.lineIdx)}
                  {@const trailStart = showInvisibles ? trailingWhitespaceStart(line.content) : line.content.length}
                  {@const commented = showInlineComments && spannedByComment(viewComments, 'New', line.new_lineno)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- mouseenter only continues an in-progress gutter drag
                       (guarded by `dragging` in the host); the row is not a control. -->
                  <div
                    class="diff-line {line.origin === 'Add' ? 'diff-line-add' : line.origin === 'Delete' ? 'diff-line-delete' : 'diff-line-context'}{commented ? ' diff-line-commented' : ''}"
                    style="
                      background: {lineBackground(line.origin, isSelected)};
                      color: {lineColor()};
                      white-space: {wordWrap ? 'pre-wrap' : 'pre'};
                    "
                    onmouseenter={(e) => onlineenter(fd.path, section.hunkIdx, row.right!.lineIdx, e)}
                  ><!-- svelte-ignore a11y_no_noninteractive_tabindex --><span
                      class="gutter{isSelectable ? ' gutter-selectable' : ''}"
                      style="min-width: {gutterW};"
                      role={isSelectable ? 'button' : undefined}
                      tabindex={isSelectable ? 0 : undefined}
                      onmousedown={(e) => { if (isSelectable && section.hunkLines) onlinemousedown(fd.path, section.hunkIdx, row.right!.lineIdx, line.origin, section.hunkLines, e); }}
                      onkeydown={(e) => { if (isSelectable && (e.key === 'Enter' || e.key === ' ') && section.hunkLines) { e.preventDefault(); onlineclick(fd.path, section.hunkIdx, row.right!.lineIdx, line.origin, section.hunkLines, new MouseEvent('click', { shiftKey: e.shiftKey })); } }}
                    >{line.new_lineno ?? ''}</span><span class="diff-line-content" style="user-select: text; -webkit-user-select: text; cursor: text;">{#if line.spans.length > 0}{#each line.spans as span}{@const sliced = line.content.slice(span.start, span.end)}{@const spanInTrailing = span.start >= trailStart}{#if showInvisibles}{@const segments = splitInvisibles(sliced, spanInTrailing || span.end > trailStart)}{#each segments as seg}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}{seg.isInvisible ? ' invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}<span class="{span.syntax_class}{span.emphasized ? (line.origin === 'Add' ? ' word-add' : ' word-delete') : ''}">{sliced}</span>{/if}{/each}{:else}{#if showInvisibles}{@const segments = splitInvisibles(line.content, false)}{#each segments as seg}<span class="{seg.isInvisible ? 'invisible-char' : ''}{seg.isTrailing ? ' trailing-ws' : ''}" data-glyph={seg.glyph}>{seg.text}</span>{/each}{:else}{line.content}{/if}{/if}</span></div>
                {:else}
                  <div class="split-phantom"></div>
                {/if}
              {/each}
              </div>
            </div>
          </div>
          {:else}
            <div class="split-comment-row">
              {#each segment.comments as comment (comment.id)}
                <ThreadCard
                  variant="inline"
                  confirmDelete={false}
                  thread={comment}
                  onedit={(id, text) => editThread(repoPath, id, text)}
                  onreplyadd={(id, text) => addReply(repoPath, id, text)}
                  onstatechange={(id, next) => setThreadState(repoPath, id, next)}
                  onreplyedit={(id, text) => editReply(repoPath, id, text)}
                  onreplydelete={(id) => deleteReply(repoPath, id)}
                  ondelete={(id) => deleteThread(repoPath, id)}
                />
              {/each}
            </div>
          {/if}
          {/each}
        {/if}
      {/each}
    {/if}
    {/if}
  </div>
{/each}

<style>
  .split-file {
    display: flex;
    flex-direction: column;
  }

  .split-columns {
    display: flex;
  }

  .split-column {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: none;
    scrollbar-width: none;
  }

  .split-column::-webkit-scrollbar {
    display: none;
  }

  .split-column:first-child {
    border-right: 1px solid var(--color-border);
  }

  .diff-line {
    position: relative;
    /* Own stacking context so the z-index:-1 hover overlay below resolves
       against this row (painting over its inline background) instead of slipping
       behind it. */
    isolation: isolate;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    padding: 0 var(--space-2);
    display: flex;
    align-items: flex-start;
  }

  /* Faint full-row tint while hovering the selectable (right) gutter — signals
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

  .gutter {
    text-align: right;
    color: var(--color-text-muted);
    padding-right: 8px;
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
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    padding: 0 var(--space-2);
    background: var(--color-diff-phantom-bg);
  }

  .split-hunk-header {
    background: color-mix(in oklch, var(--info) 6%, var(--bg-2));
    color: color-mix(in oklch, var(--info) 70%, var(--fg-3));
    display: flex;
    align-items: center;
    padding: var(--space-1) var(--space-2);
    gap: var(--space-2);
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
    white-space: nowrap;
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

  :global(.hunk-highlight) {
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
     Every line carries the 3px border so columns stay aligned regardless of origin. */
  .diff-line {
    border-left: 3px solid var(--color-border);
  }
  .diff-line-add {
    border-left-color: var(--color-diff-add);
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

  /* Inline comment row: a plain full-width block sibling spanning both columns
     (sibling of .split-columns, not inside a single column). */
  .split-comment-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    width: 100%;
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
