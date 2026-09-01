<script lang="ts">
import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { externalLinks } from "../../lib/external-links.js";
import { isTrunkError } from "../../lib/invoke.js";
import {
	afterRev,
	beforeRev,
	type DiffRow,
	renderMarkdownDiff,
} from "../../lib/markdown.js";
import { createHorizontalScrollSync } from "../../lib/scroll-sync.js";
import type { CommitDetail } from "../../lib/types.js";

// All split columns pan as one under wrap-off (Source's splitColSync model):
// scrolling any column mirrors its scrollLeft to every other.
const colSync = createHorizontalScrollSync();

// Rendered markdown view of a `.md` diff, projected from one fetch
// (`render_markdown_diff`, both revs). Row semantics derive from the plain-text
// line diff of the two sources — the same diff Source shows — mapped onto blocks.
// Every layout — inline/split × full/hunk — is a pure frontend projection of the
// returned rows; toggling never re-invokes Rust. Split pairs each row's
// before/after cells in one CSS grid row. Inline is a single stream; a changed
// block that merges — a single leaf, or a container built from its after
// skeleton — collapses to ONE block carrying inline `md-word-*` del/ins
// (`mergedHtml`). Code, dense rewrites and structural failures don't merge, and
// show before(red)+after(green) instead.
interface Props {
	layoutMode: "inline" | "split";
	selectedPath: string;
	diffKind: "unstaged" | "staged" | "commit";
	commitOid: string;
	repoPath: string;
	commitDetail: CommitDetail | null;
	contentMode: "hunk" | "full";
	contextLines: number;
	ignoreWhitespace: boolean;
	wordWrap: boolean;
	// Bumped by the host when the repo changes on disk (RepoView's debounced
	// repo-changed handler) so a stale preview refetches. Optional: the rebase-
	// mode DiffPanel doesn't thread it (rebase-preview staleness is out of scope).
	refreshToken?: number;
	// DiffPanel's jump-target record: registering each changed row here makes
	// its existing ]/[ navigation (scrollToHunk) work over rendered rows.
	hunkElements?: Record<string, HTMLDivElement>;
}

let {
	layoutMode,
	selectedPath,
	diffKind,
	commitOid,
	repoPath,
	commitDetail,
	contentMode,
	contextLines,
	ignoreWhitespace,
	wordWrap,
	refreshToken = 0,
	hunkElements,
}: Props = $props();

// Each changed row's first content block, keyed by its document-order change
// index. An action feeds this; the effect below projects it into the host's
// `hunkElements` record.
const changeRegistry = new SvelteMap<number, HTMLDivElement>();

function registerChange(node: HTMLDivElement, index: number | null) {
	const put = (i: number | null) => {
		if (i !== null) changeRegistry.set(i, node);
	};
	// During a re-projection a new element can claim the index before the old
	// one unregisters — only ever delete this node's own entry.
	const drop = (i: number | null) => {
		if (i !== null && changeRegistry.get(i) === node) changeRegistry.delete(i);
	};
	put(index);
	return {
		update(next: number | null) {
			drop(index);
			index = next;
			put(index);
		},
		destroy() {
			drop(index);
		},
	};
}

// Rebuild the host record in document order on every registry change, and
// clear this view's entries on unmount so a switch back to Source starts
// clean. Writes are untracked: the effect must not depend on the record's
// own keys (read-and-write of the same state loops).
$effect(() => {
	const record = hunkElements;
	if (!record) return;
	const ordered = [...changeRegistry.entries()].sort(([a], [b]) => a - b);
	untrack(() => {
		for (const key of Object.keys(record)) delete record[key];
		ordered.forEach(([, el], i) => {
			record[`change-${i}`] = el;
		});
	});
	return () =>
		untrack(() => {
			for (const key of Object.keys(record)) delete record[key];
		});
});

type LoadState =
	| { kind: "loading" }
	| { kind: "rows"; rows: DiffRow[]; whitespaceOnly: boolean }
	| { kind: "error"; message: string };

let state = $state<LoadState>({ kind: "loading" });

// Per-run token: each effect run bumps it, and a fetch's async result is only
// applied if its run is still the latest. Without this, switching files or revs
// while a fetch is in flight lets the slower stale request clobber the fresh one.
let seq = 0;

const parentOid = $derived(commitDetail?.parent_oids[0] ?? null);

$effect(() => {
	// Snapshot every dependency up front so the async resolve isn't racing a
	// later reactive change. Layout/content-mode are deliberately NOT read here:
	// they re-project the held array, they must not re-fetch.
	const my = ++seq;
	const repo = repoPath;
	const path = selectedPath;
	const kind = diffKind;
	const oid = commitOid;
	const parent = parentOid;
	const ignoreWs = ignoreWhitespace;
	// A dependency only: the token's value never reaches the backend — bumping
	// it re-runs this effect so the same fetch re-executes against fresh disk.
	void refreshToken;

	state = { kind: "loading" };
	renderMarkdownDiff(
		repo,
		path,
		beforeRev(kind, parent),
		afterRev(kind, oid),
		ignoreWs,
	)
		.then((diff) => {
			if (my === seq)
				state = {
					kind: "rows",
					rows: diff.rows,
					whitespaceOnly: diff.whitespaceOnly,
				};
		})
		.catch((e) => {
			if (my !== seq) return;
			state = {
				kind: "error",
				message: isTrunkError(e) ? e.message : "Failed to render markdown",
			};
		});
});

const rows = $derived(state.kind === "rows" ? state.rows : []);
const hasChanges = $derived(rows.some((r) => r.kind !== "unchanged"));

// Hunk mode over an unchanged document renders the full doc (projected keeps all
// rows) plus this note, rather than folding to one blank separator (criterion 4).
// When the sources differ but only in ways the rendered view cannot represent
// (whitespace between blocks), the note says so instead of claiming "No changes".
const showNoChange = $derived(
	contentMode === "hunk" && rows.length > 0 && !hasChanges,
);
const noChangeLabel = $derived(
	state.kind === "rows" && state.whitespaceOnly
		? "Whitespace-only changes — not visible in rendered view"
		: "No changes",
);

// Which split column is genuinely absent (added file → no before; deleted file →
// no after). The backend returns all-added / all-removed for a `not_found` side,
// so an all-one-kind array is the signal. Split shows one placeholder for that
// column rather than a phantom per row; inline just streams the blocks.
const absentSide = $derived.by((): "before" | "after" | null => {
	if (rows.length === 0) return null;
	if (rows.every((r) => r.kind === "added")) return "before";
	if (rows.every((r) => r.kind === "removed")) return "after";
	return null;
});

// The present column's block fragments when one side is absent. `added`/`removed`
// both carry `html`; the kind check narrows the union so no cast is needed.
const presentHtmls = $derived(
	rows.flatMap((r) =>
		r.kind === "added" || r.kind === "removed" ? [r.html] : [],
	),
);

type Tint = "unchanged" | "added" | "removed";

// The rows to actually render, after hunk-mode collapse folds runs of unchanged
// blocks into separators. Both inline and split project from this same list, so a
// run collapses identically in either layout — and reads the same `changeIndex`
// (each changed row's document-order position, the ]/[ jump order; null on
// unchanged rows). Full mode (and the no-change case) keeps every row.
type ProjectedRow =
	| { type: "row"; row: DiffRow; changeIndex: number | null }
	| { type: "sep"; count: number };

// An inclusive after-axis source-line range.
type Span = { start: number; end: number };

// Every row's position on the AFTER axis, where all context math runs: a
// removed row has no after side, so it sits at its one-line anchor.
function rowSpan(r: DiffRow): Span {
	if (r.kind === "removed") return { start: r.afterAnchor, end: r.afterAnchor };
	return { start: r.afterStart, end: r.afterEnd };
}

// Edge-to-edge source-line distance between two spans: adjacent lines are 1
// apart, overlapping spans 0 — so "within N lines" means exactly Source's N
// context lines (a row starting N+1 lines away is outside the window).
function lineDistance(a: Span, b: Span): number {
	if (b.start > a.end) return b.start - a.end;
	if (a.start > b.end) return a.start - b.end;
	return 0;
}

// Keep unchanged blocks as context around each change so hunk context matches
// Source's `diff_context_lines`: an unchanged row stays iff its after-axis span
// is within `contextLines` source lines of a change (a removed row participates
// via its anchor), and the immediately-adjacent unchanged row on each side of a
// change is always kept — a change is never left bare, matching Source always
// showing context. A collapsed run at the document edge is dropped entirely (no
// separator, like source hunks); interior runs collapse to a separator counting
// the hidden source lines, gaps between blocks included.
function collapseUnchanged(
	diffRows: DiffRow[],
	contextLines: number,
): ProjectedRow[] {
	const changeSpans = diffRows
		.filter((r) => r.kind !== "unchanged")
		.map(rowSpan);
	const keep = diffRows.map(
		(r) =>
			r.kind !== "unchanged" ||
			changeSpans.some((c) => lineDistance(rowSpan(r), c) <= contextLines),
	);
	diffRows.forEach((r, i) => {
		if (r.kind === "unchanged") return;
		if (i > 0) keep[i - 1] = true;
		if (i < keep.length - 1) keep[i + 1] = true;
	});

	const out: ProjectedRow[] = [];
	let i = 0;
	while (i < diffRows.length) {
		if (keep[i]) {
			out.push({ type: "row", row: diffRows[i], changeIndex: null });
			i++;
			continue;
		}
		let j = i;
		while (j < diffRows.length && !keep[j]) j++;
		const atEdge = i === 0 || j === diffRows.length;
		if (!atEdge) {
			const count =
				rowSpan(diffRows[j]).start - rowSpan(diffRows[i - 1]).end - 1;
			out.push({ type: "sep", count });
		}
		i = j;
	}
	return out;
}

const projected = $derived.by((): ProjectedRow[] => {
	// Full mode, and the no-change case (criterion 4), show every row: nothing to
	// collapse, and an all-unchanged doc must not fold to one blank separator.
	const base: ProjectedRow[] =
		contentMode !== "hunk" || !hasChanges
			? rows.map(
					(row): ProjectedRow => ({ type: "row", row, changeIndex: null }),
				)
			: collapseUnchanged(rows, contextLines);
	let change = 0;
	return base.map(
		(p): ProjectedRow =>
			p.type === "row" && p.row.kind !== "unchanged"
				? { ...p, changeIndex: change++ }
				: p,
	);
});

// One inline stream item: a tinted block or a collapsed-run separator. Only a
// changed row's FIRST block carries its changeIndex — a two-block changed row
// registers exactly one jump target.
type InlineItem =
	| {
			type: "block";
			tint: Tint;
			html: string;
			changeIndex: number | null;
			wash: boolean;
			// Leaves the backend folded out of this block's hunk-mode copy, for
			// the "N items hidden" note under it. 0 when nothing was folded.
			hiddenLeaves: number;
			// The note under a block whose two sides render the same text: a
			// reflow has nothing to tint, so without this it draws as an
			// untinted block with no reason to be there. Null when it changed
			// visibly and the tints already say so.
			note: string | null;
	  }
	| { type: "sep"; count: number };

// The copy of a changed CONTAINER to render: hunk mode prefers the folded copy
// (unchanged leaves outside the context window dropped, TRUNK-93), full mode
// always shows every leaf. A row with no folded copy — a single-leaf block, or
// a container with nothing to fold — renders its merged copy in both modes.
// What to say under a block whose two sides render the same visible text. Only
// a reflow reaches this: the source lines moved, no rendered word did, so there
// is nothing to tint and the block would otherwise look unchanged for no
// stated reason.
function reflowNote(r: DiffRow & { kind: "changed" }): string | null {
	return r.rendersIdentically ? "Reflowed — renders identically" : null;
}

function mergedCopy(r: DiffRow & { kind: "changed" }): {
	html: string | undefined;
	hiddenLeaves: number;
} {
	if (contentMode === "hunk" && r.hunkMergedHtml)
		return { html: r.hunkMergedHtml, hiddenLeaves: r.hunkHiddenLeaves ?? 0 };
	return { html: r.mergedHtml, hiddenLeaves: 0 };
}

const inlineItems = $derived.by((): InlineItem[] =>
	projected.flatMap((p): InlineItem[] => {
		if (p.type === "sep") return [p];
		const r = p.row;
		const changeIndex = p.changeIndex;
		if (r.kind === "unchanged")
			return [
				{
					type: "block",
					tint: "unchanged",
					html: r.html,
					changeIndex: null,
					wash: true,
					hiddenLeaves: 0,
					note: null,
				},
			];
		if (r.kind === "added")
			return [
				{
					type: "block",
					tint: "added",
					html: r.html,
					changeIndex,
					wash: true,
					hiddenLeaves: 0,
					note: null,
				},
			];
		if (r.kind === "removed")
			return [
				{
					type: "block",
					tint: "removed",
					html: r.html,
					changeIndex,
					wash: true,
					hiddenLeaves: 0,
					note: null,
				},
			];
		// The suggestion-mode copy: ONE block carrying del/ins marks and
		// red/green leaves together. A block with no merged copy (code, dense
		// rewrite, structural failure) falls through to the before/after pair.
		const merged = mergedCopy(r);
		if (merged.html)
			return [
				{
					type: "block",
					tint: "unchanged",
					html: merged.html,
					changeIndex,
					wash: true,
					hiddenLeaves: merged.hiddenLeaves,
					note: reflowNote(r),
				},
			];
		// changed without a merge (code / dense rewrite / structural failure):
		// mirror Source —
		// the removed before-block, then the added after-block. A row whose leaves
		// are tinted already points at the change, so it keeps the rail and drops
		// the background; one with nothing to point at needs the full wash.
		const wash = !r.hasTints;
		return [
			{
				type: "block",
				tint: "removed",
				html: r.beforeHtml,
				changeIndex,
				wash,
				hiddenLeaves: 0,
				note: null,
			},
			{
				type: "block",
				tint: "added",
				html: r.afterHtml,
				changeIndex: null,
				wash,
				hiddenLeaves: 0,
				note: reflowNote(r),
			},
		];
	}),
);

// One split row: a before cell + an after cell (either may be a phantom where
// that side has no block). Rows group into RUNS between separators; each run
// renders as ONE column pair (Source's d1c299f model — scroll containers at the
// column level, never per row, so short rows pan with the run's shared plane).
type SplitCell = { tint: Tint; html: string; wash: boolean } | null;
type SplitRow = {
	left: SplitCell;
	right: SplitCell;
	changeIndex: number | null;
};
type SplitSegment =
	| { type: "run"; rows: SplitRow[] }
	| { type: "sep"; count: number };

function toSplitRow(r: DiffRow, changeIndex: number | null): SplitRow {
	if (r.kind === "unchanged")
		return {
			left: { tint: "unchanged", html: r.html, wash: true },
			right: { tint: "unchanged", html: r.html, wash: true },
			changeIndex,
		};
	if (r.kind === "added")
		return {
			left: null,
			right: { tint: "added", html: r.html, wash: true },
			changeIndex,
		};
	if (r.kind === "removed")
		return {
			left: { tint: "removed", html: r.html, wash: true },
			right: null,
			changeIndex,
		};
	// changed: whole before(red) on the left, after(green) on the right — split
	// stays block-level (word-level lives in the inline view). The wash goes only
	// where the leaf tints already mark what changed. In hunk mode a container
	// uses its folded column fragments, so both columns hide the same leaves and
	// stay row-aligned (TRUNK-93).
	const wash = !r.hasTints;
	const folded = contentMode === "hunk" && r.hunkBeforeHtml && r.hunkAfterHtml;
	return {
		left: {
			tint: "removed",
			html: folded ? (r.hunkBeforeHtml as string) : r.beforeHtml,
			wash,
		},
		right: {
			tint: "added",
			html: folded ? (r.hunkAfterHtml as string) : r.afterHtml,
			wash,
		},
		changeIndex,
	};
}

// The jump target registers on the row's first content-bearing cell: the left
// (before) side when it exists, otherwise the right (an added row's left cell
// is a phantom).
function cellChangeIndex(row: SplitRow, side: "left" | "right"): number | null {
	if (row.changeIndex === null) return null;
	const registerSide = row.left !== null ? "left" : "right";
	return side === registerSide ? row.changeIndex : null;
}

const splitSegments = $derived.by((): SplitSegment[] => {
	const segments: SplitSegment[] = [];
	let run: SplitRow[] = [];
	for (const p of projected) {
		if (p.type === "sep") {
			if (run.length > 0) segments.push({ type: "run", rows: run });
			run = [];
			segments.push(p);
			continue;
		}
		run.push(toSplitRow(p.row, p.changeIndex));
	}
	if (run.length > 0) segments.push({ type: "run", rows: run });
	return segments;
});

// Equalize each row pair's height across the two column stacks: cells sit in
// separate scrollers, so CSS alone cannot align them. Observes each cell's
// natural content (the inner .markdown-body — NOT the flex-stretched block, so
// setting the cell height can never re-trigger the observer) and sets both
// cells of a pair to the taller side.
function rowHeights(node: HTMLElement, _rows: readonly SplitRow[]) {
	let observer: ResizeObserver | null = null;

	function cellsOf(side: "left" | "right"): HTMLElement[] {
		return [
			...node.querySelectorAll(`.split-cell[data-side="${side}"]`),
		].filter((el): el is HTMLElement => el instanceof HTMLElement);
	}

	function naturalHeight(cell: HTMLElement): number {
		const content = cell.querySelector(".markdown-body");
		const block = cell.querySelector(".rendered-block");
		if (!(content instanceof HTMLElement) || !(block instanceof HTMLElement))
			return 0;
		const style = getComputedStyle(block);
		return (
			content.offsetHeight +
			Number.parseFloat(style.paddingTop) +
			Number.parseFloat(style.paddingBottom)
		);
	}

	function equalize() {
		const left = cellsOf("left");
		const right = cellsOf("right");
		for (let i = 0; i < left.length; i++) {
			const h = Math.max(naturalHeight(left[i]), naturalHeight(right[i]));
			left[i].style.height = `${h}px`;
			right[i].style.height = `${h}px`;
		}
	}

	function observe() {
		observer?.disconnect();
		observer = new ResizeObserver(equalize);
		for (const content of node.querySelectorAll(".split-cell .markdown-body")) {
			observer.observe(content);
		}
		equalize();
	}

	observe();
	return {
		update(_rows: readonly SplitRow[]) {
			observe();
		},
		destroy() {
			observer?.disconnect();
		},
	};
}
</script>

{#snippet block(
  tint: Tint,
  html: string,
  changeIndex: number | null = null,
  wash = true
)}
  <!-- Tint (bg + rail) on the outer wrapper; the prose lives in an inner
       .markdown-body so the height equalizer can observe natural content
       height while the wrapper flex-stretches to the row height. `no-wash`
       keeps the rail and drops the background, for a row whose own leaf tints
       already mark the change. -->
  <div
    class="rendered-block"
    class:md-added={tint === "added"}
    class:md-removed={tint === "removed"}
    class:no-wash={!wash}
    use:externalLinks
    use:registerChange={changeIndex}
  ><div class="markdown-body">{@html html}</div></div>
{/snippet}

<!-- What the container fold dropped from this block's hunk-mode copy. Sits
     under the block, reading as part of it rather than as a document-level
     seam (that is `.rendered-sep`). Non-expandable, like the separator. -->
{#snippet foldNote(count: number)}
  <div class="rendered-fold">
    {count} item{count === 1 ? "" : "s"} hidden
  </div>
{/snippet}

{#snippet separator(count: number)}
  <div class="rendered-sep" role="separator">
    <span class="rendered-sep-label"
      >{count} line{count === 1 ? "" : "s"} hidden</span
    >
  </div>
{/snippet}

{#snippet cell(
  side: "left" | "right",
  c: SplitCell,
  changeIndex: number | null = null
)}
  {#if c}
    <div class="split-cell" data-side={side}>
      {@render block(c.tint, c.html, changeIndex, c.wash)}
    </div>
  {:else}
    <div class="split-cell rendered-phantom" data-side={side}></div>
  {/if}
{/snippet}

{#snippet columnStack(rows: SplitRow[], side: "left" | "right")}
  <!-- ONE hidden-scrollbar horizontal scroller per column per run (Source's
       .split-column, d1c299f): every row of the run stacks inside the same
       max-content wrapper, so short rows pan on the run's shared plane and
       tints span the full scrolled width. -->
  <div class="split-column" use:colSync>
    <div
      class="split-col-content"
      style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};"
    >
      {#each rows as row}
        {@render cell(
          side,
          side === "left" ? row.left : row.right,
          cellChangeIndex(row, side)
        )}
      {/each}
    </div>
  </div>
{/snippet}

<div class="rendered-diff" class:wrap={wordWrap}>
  <!-- ONE shared content wrapper sized by the wrap toggle (Source's HunkView
       pattern): at max-content every inline block, tint, and separator spans the
       same scrolled width. In split the outer wrapper never widens — panning
       lives inside the per-row columns. -->
  <div
    class="rendered-content"
    class:split={layoutMode === "split"}
    style="min-width: 100%; width: {wordWrap || layoutMode === 'split'
      ? '100%'
      : 'max-content'};"
  >
    {#if showNoChange}
      <div class="rendered-nochange">{noChangeLabel}</div>
    {/if}
    {#if state.kind === "error"}
      <div class="rendered-note rendered-error">{state.message}</div>
    {:else if state.kind === "loading"}
      <div class="rendered-block"></div>
    {:else if layoutMode === "split" && absentSide === "before"}
      <div class="split-columns">
        <div class="split-column rendered-note">Not present at this revision</div>
        <div class="split-column" use:colSync>
          <div
            class="split-col-content"
            style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};"
          >
            {#each presentHtmls as html}{@render block("added", html)}{/each}
          </div>
        </div>
      </div>
    {:else if layoutMode === "split" && absentSide === "after"}
      <div class="split-columns">
        <div class="split-column" use:colSync>
          <div
            class="split-col-content"
            style="min-width: 100%; width: {wordWrap ? '100%' : 'max-content'};"
          >
            {#each presentHtmls as html}{@render block("removed", html)}{/each}
          </div>
        </div>
        <div class="split-column rendered-note">Not present at this revision</div>
      </div>
    {:else if layoutMode === "split"}
      {#each splitSegments as segment}
        {#if segment.type === "sep"}
          {@render separator(segment.count)}
        {:else}
          <div class="split-columns" use:rowHeights={segment.rows}>
            {@render columnStack(segment.rows, "left")}
            {@render columnStack(segment.rows, "right")}
          </div>
        {/if}
      {/each}
    {:else}
      {#each inlineItems as item}
        {#if item.type === "sep"}
          {@render separator(item.count)}
        {:else}
          {@render block(item.tint, item.html, item.changeIndex, item.wash)}
          {#if item.note}<div class="rendered-fold">{item.note}</div>{/if}
          {#if item.hiddenLeaves > 0}{@render foldNote(item.hiddenLeaves)}{/if}
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Single outer scroller: vertical scroll needs no JS sync, and in split the
     grid rows align both columns structurally. */
  .rendered-diff {
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    background: var(--bg-0);
  }
  /* One flex pair per DiffRow (Source's .split-columns): the row's height is
     max(left, right) via flex stretch, so variable-height blocks stay row-aligned
     without a shared grid. */
  .split-columns {
    display: flex;
  }
  /* Half-panel column that pans horizontally on its own (scrollbars hidden,
     panning synced across all columns) — Source's .split-column verbatim. This is
     what keeps split at panel width under wrap-off instead of widening 2×. */
  .split-column {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: none;
    scrollbar-width: none;
    background: var(--bg-0);
  }
  .split-column:first-child {
    border-right: 1px solid var(--color-border);
  }
  /* No overflow here: any non-visible overflow on one axis forces the other to
     compute non-visible too, turning the block into a scroll container whose grid
     row can then collapse below its content and clip it. Blocks flow at natural
     height so each grid row is max(left, right); wide children (code fences,
     tables, images) self-contain via their own overflow in app.css. min-width:0
     lets a wide <pre>'s internal scroller work without stretching the 1fr track.
     NO background here: this scoped rule outranks the global .md-added/.md-removed
     tints (app.css), so an opaque bg-0 would swallow them — the regression that
     left only the 3px rail visible. Untinted blocks show the pane's bg-0.
     Padding-only box: rowHeights reconstructs each cell as markdown-body height
     + this padding — a border or margin here silently breaks row equalization. */
  .rendered-block {
    padding: var(--space-2) var(--space-4);
    min-width: 0;
  }
  /* GitHub's comment-prose size; the 16px browser default reads oversized
     against the app's 11-13px chrome. Heading/code sizes are em-based and
     scale with it. */
  .rendered-block > :global(.markdown-body) {
    font-size: 14px;
  }
  /* The toolbar's word-wrap toggle, mirroring Source's semantics (HunkView:
     pre-wrap + 100% when on, pre + max-content when off).
     ON: prose wraps natively; code fences flip from their pre scroller to
     pre-wrap. :global reaches the {@html}-injected fragment Svelte scoping can't. */
  .rendered-diff.wrap :global(.markdown-body pre code) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* OFF: nothing wraps — nowrap inherits into the injected prose (a paragraph is
     one long line; `pre code` keeps its explicit white-space:pre). The shared
     wrapper's max-content width makes every block span the widest line; the
     outer .rendered-diff scroller pans horizontally, like Source. */
  .rendered-diff:not(.wrap) .rendered-content {
    white-space: nowrap;
  }
  /* One row's slot in a column stack. Explicit height comes from the
     rowHeights equalizer (max of the pair); the block flex-stretches into it
     so its tint fills the whole row slot. */
  .split-cell {
    display: flex;
    flex-direction: column;
  }
  .split-cell > .rendered-block {
    flex: 1;
  }
  /* The empty counterpart cell of an added/removed block: same equalized
     height, carries no content. */
  .split-cell.rendered-phantom {
    background: var(--color-diff-phantom-bg);
  }
  /* A collapsed run of unchanged blocks: a full-width sibling of the .split-columns
     rows in split, a plain block inline. A centered count flanked by hairline
     rules, so the fold reads as a seam in the content rather than a boxed-in
     banner. Non-expandable, matching Source (criterion 12). */
  .rendered-sep {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-0);
  }
  .rendered-sep::before,
  .rendered-sep::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }
  /* The container fold's note. Muted and indented to the block's own padding,
     so it reads as a footnote to the block above rather than a divider. */
  .rendered-fold {
    padding: 0 var(--space-4) var(--space-2);
    color: var(--color-text-muted);
    font-size: 11px;
    font-style: italic;
    letter-spacing: 0.02em;
  }
  .rendered-sep-label {
    color: var(--color-text-muted);
    font-size: 11px;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .rendered-nochange {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-1);
    color: var(--color-text-muted);
    font-size: 12px;
    font-style: italic;
    text-align: center;
    border-block-end: 1px solid var(--color-border);
  }
  .rendered-note {
    padding: var(--space-4);
    color: var(--color-text-muted);
    font-size: 13px;
    font-style: italic;
  }
  .rendered-error {
    color: var(--color-danger);
  }
</style>
