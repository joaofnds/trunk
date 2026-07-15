<script lang="ts">
import { externalLinks } from "../../lib/external-links.js";
import { isTrunkError } from "../../lib/invoke.js";
import {
	afterRev,
	beforeRev,
	type DiffRow,
	renderMarkdownDiff,
} from "../../lib/markdown.js";
import type { CommitDetail } from "../../lib/types.js";

// Rendered markdown view of a `.md` diff, projected from one block-diff fetch
// (`render_markdown_diff`, both revs). Every layout — inline/split × full/hunk —
// is a pure frontend projection of the returned `DiffRow[]`; toggling never
// re-invokes Rust (grill §B). Inline is a single interleaved stream (removed
// blocks shown in original position); split pairs each row's before/after cells
// in one CSS grid row so heights align structurally (grill §A).
interface Props {
	layoutMode: "inline" | "split";
	selectedPath: string;
	diffKind: "unstaged" | "staged" | "commit";
	commitOid: string;
	repoPath: string;
	commitDetail: CommitDetail | null;
	contentMode: "hunk" | "full";
	contextLines: number;
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
}: Props = $props();

type LoadState =
	| { kind: "loading" }
	| { kind: "rows"; rows: DiffRow[] }
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

	state = { kind: "loading" };
	renderMarkdownDiff(repo, path, beforeRev(kind, parent), afterRev(kind, oid))
		.then((rows) => {
			if (my === seq) state = { kind: "rows", rows };
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
const showNoChange = $derived(
	contentMode === "hunk" && rows.length > 0 && !hasChanges,
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
// run collapses identically in either layout. Full mode (and the no-change case)
// keeps every row.
type ProjectedRow =
	| { type: "row"; row: DiffRow }
	| { type: "sep"; count: number };

// Keep unchanged blocks as context around each change so hunk context matches
// Source's `diff_context_lines` (a per-side line count). Walking out from each
// change, keep the immediately-adjacent block always, then keep further blocks
// until the cumulative source-line count reaches the budget. Blocks are atomic,
// so the adjacent block is shown whole even when it alone exceeds the budget — a
// change is never left bare, matching Source always showing context. A collapsed
// run at the document edge is dropped entirely (no separator, like source hunks);
// interior runs collapse to a separator.
function collapseUnchanged(
	diffRows: DiffRow[],
	lineBudget: number,
): ProjectedRow[] {
	const keep = diffRows.map((r) => r.kind !== "unchanged");
	const lineCount = (r: DiffRow) => (r.kind === "unchanged" ? r.lines : 0);

	diffRows.forEach((r, i) => {
		if (r.kind === "unchanged") return;
		for (const step of [-1, 1]) {
			let used = 0;
			for (
				let j = i + step;
				j >= 0 && j < diffRows.length && diffRows[j].kind === "unchanged";
				j += step
			) {
				keep[j] = true;
				used += lineCount(diffRows[j]);
				if (used >= lineBudget) break;
			}
		}
	});

	const out: ProjectedRow[] = [];
	let i = 0;
	while (i < diffRows.length) {
		if (keep[i]) {
			out.push({ type: "row", row: diffRows[i] });
			i++;
			continue;
		}
		let j = i;
		while (j < diffRows.length && !keep[j]) j++;
		const atEdge = i === 0 || j === diffRows.length;
		if (!atEdge) out.push({ type: "sep", count: j - i });
		i = j;
	}
	return out;
}

const projected = $derived.by((): ProjectedRow[] => {
	// Full mode, and the no-change case (criterion 4), show every row: nothing to
	// collapse, and an all-unchanged doc must not fold to one blank separator.
	if (contentMode !== "hunk" || !hasChanges)
		return rows.map((row): ProjectedRow => ({ type: "row", row }));
	return collapseUnchanged(rows, contextLines);
});

// One inline stream item: a tinted block or a collapsed-run separator.
type InlineItem =
	| { type: "block"; tint: Tint; html: string }
	| { type: "sep"; count: number };

const inlineItems = $derived.by((): InlineItem[] =>
	projected.flatMap((p): InlineItem[] => {
		if (p.type === "sep") return [p];
		const r = p.row;
		if (r.kind === "unchanged")
			return [{ type: "block", tint: "unchanged", html: r.html }];
		if (r.kind === "added")
			return [{ type: "block", tint: "added", html: r.html }];
		if (r.kind === "removed")
			return [{ type: "block", tint: "removed", html: r.html }];
		// changed: mirror Source — the removed before-block, then the added after-block.
		return [
			{ type: "block", tint: "removed", html: r.beforeHtml },
			{ type: "block", tint: "added", html: r.afterHtml },
		];
	}),
);

// One split grid row: a before cell + an after cell (either may be a phantom
// where that side has no block), or a full-width collapsed-run separator. Both
// cells emit as adjacent grid children so the row's height is max(left, right).
type SplitCell = { tint: Tint; html: string } | null;
type SplitItem =
	| { type: "row"; left: SplitCell; right: SplitCell }
	| { type: "sep"; count: number };

const splitItems = $derived.by((): SplitItem[] =>
	projected.map((p): SplitItem => {
		if (p.type === "sep") return p;
		const r = p.row;
		if (r.kind === "unchanged")
			return {
				type: "row",
				left: { tint: "unchanged", html: r.html },
				right: { tint: "unchanged", html: r.html },
			};
		if (r.kind === "added")
			return {
				type: "row",
				left: null,
				right: { tint: "added", html: r.html },
			};
		if (r.kind === "removed")
			return {
				type: "row",
				left: { tint: "removed", html: r.html },
				right: null,
			};
		// changed: mirror Source — before removed (red) on the left, after added
		// (green) on the right.
		return {
			type: "row",
			left: { tint: "removed", html: r.beforeHtml },
			right: { tint: "added", html: r.afterHtml },
		};
	}),
);
</script>

{#snippet block(tint: Tint, html: string)}
  <div
    class="rendered-block markdown-body"
    class:md-added={tint === "added"}
    class:md-removed={tint === "removed"}
    use:externalLinks
  >{@html html}</div>
{/snippet}

{#snippet separator(count: number)}
  <div class="rendered-sep" role="separator">
    <span class="rendered-sep-label"
      >{count} unchanged block{count === 1 ? "" : "s"} hidden</span
    >
  </div>
{/snippet}

{#snippet cell(c: SplitCell)}
  {#if c}
    {@render block(c.tint, c.html)}
  {:else}
    <div class="rendered-phantom"></div>
  {/if}
{/snippet}

<div class="rendered-diff" class:split={layoutMode === "split"}>
  {#if showNoChange}
    <div class="rendered-nochange">No changes</div>
  {/if}
  {#if state.kind === "error"}
    <div class="rendered-note rendered-error">{state.message}</div>
  {:else if state.kind === "loading"}
    <div class="rendered-block"></div>
  {:else if layoutMode === "split" && absentSide === "before"}
    <div class="rendered-col rendered-note">Not present at this revision</div>
    <div class="rendered-stack">
      {#each presentHtmls as html}{@render block("added", html)}{/each}
    </div>
  {:else if layoutMode === "split" && absentSide === "after"}
    <div class="rendered-stack">
      {#each presentHtmls as html}{@render block("removed", html)}{/each}
    </div>
    <div class="rendered-col rendered-note">Not present at this revision</div>
  {:else if layoutMode === "split"}
    {#each splitItems as item}
      {#if item.type === "sep"}
        {@render separator(item.count)}
      {:else}
        {@render cell(item.left)}
        {@render cell(item.right)}
      {/if}
    {/each}
  {:else}
    {#each inlineItems as item}
      {#if item.type === "sep"}
        {@render separator(item.count)}
      {:else}
        {@render block(item.tint, item.html)}
      {/if}
    {/each}
  {/if}
</div>

<style>
  /* Single outer scroller: vertical scroll needs no JS sync, and in split the
     grid rows align both columns structurally (grill §A). */
  .rendered-diff {
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
    background: var(--bg-0);
  }
  /* Each DiffRow's before/after cells are adjacent grid children, so a row's
     height is max(left, right) — exact alignment of variable-height blocks. The
     1px column gap on the border color draws the split rule. */
  .rendered-diff.split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 1px;
    background: var(--color-border);
  }
  /* No overflow here: any non-visible overflow on one axis forces the other to
     compute non-visible too, turning the block into a scroll container whose grid
     row can then collapse below its content and clip it. Blocks flow at natural
     height so each grid row is max(left, right); wide children (code fences,
     tables, images) self-contain via their own overflow in app.css. min-width:0
     lets a wide <pre>'s internal scroller work without stretching the 1fr track. */
  .rendered-block {
    padding: 16px 20px;
    background: var(--bg-0);
    min-width: 0;
  }
  /* One grid cell holding the whole present column when the other side is absent
     (added/deleted file), so the placeholder stays a single opposite-column cell
     rather than a phantom per row. */
  .rendered-stack {
    min-width: 0;
    background: var(--bg-0);
  }
  /* The empty counterpart of an added/removed block: fills its grid cell so the
     split rule stays continuous, carries no content. */
  .rendered-phantom {
    background: var(--color-diff-phantom-bg);
  }
  /* A collapsed run of unchanged blocks. Spans both columns in split. A centered
     count flanked by hairline rules, so the fold reads as a seam in the content
     rather than a boxed-in banner. Non-expandable, matching Source (criterion 12). */
  .rendered-sep {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 20px;
    background: var(--bg-0);
  }
  .rendered-sep::before,
  .rendered-sep::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }
  .rendered-sep-label {
    color: var(--color-text-muted);
    font-size: 11px;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .rendered-nochange {
    grid-column: 1 / -1;
    padding: 6px 20px;
    background: var(--bg-1);
    color: var(--color-text-muted);
    font-size: 12px;
    font-style: italic;
    text-align: center;
    border-block-end: 1px solid var(--color-border);
  }
  .rendered-note {
    padding: 16px 20px;
    color: var(--color-text-muted);
    font-size: 13px;
    font-style: italic;
  }
  .rendered-error {
    color: var(--color-danger);
  }
</style>
