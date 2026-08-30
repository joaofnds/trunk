<script lang="ts">
import { copySha } from "../lib/clipboard.js";
import { parseSummary, prefixToneVar } from "../lib/commit-prefix.js";
import type { SelectModifiers } from "../lib/compare-select.js";
import { diffBarFractions } from "../lib/diff-stat.js";
import {
	COLUMN_PADDING_X,
	LANE_WIDTH,
	ROW_HEIGHT,
} from "../lib/graph-constants.js";
import { currentMinute } from "../lib/now.svelte.js";
import { relativeLabel } from "../lib/relative-time.js";
import { STATUS_BADGES, WIP_BADGE_ORDER } from "../lib/status-badges.js";
import type { ColumnVisibility, ColumnWidths } from "../lib/store.js";
import { tooltip } from "../lib/tooltip.js";
import type { DiffStat, GraphCommit, WipStats } from "../lib/types.js";
import Avatar from "./Avatar.svelte";
import CommentBadge from "./CommentBadge.svelte";

interface Props {
	commit: GraphCommit;
	rowIndex: number;
	onselect?: (oid: string, mods?: SelectModifiers) => void;
	oncontextmenu?: (e: MouseEvent, commit: GraphCommit) => void;
	maxColumns?: number;
	columnWidths: ColumnWidths;
	columnVisibility: ColumnVisibility;
	selected?: boolean;
	/** Row height in px. Defaults to ROW_HEIGHT constant.
	 *  Accepts displaySettings.rowHeight from CommitGraph for future settings-page wiring. */
	rowHeight?: number;
	/** True when this row's OID is in the search results */
	isSearchMatch?: boolean;
	/** True when this row is the current navigated match */
	isCurrentMatch?: boolean;
	/** True when any search is active (for dimming non-matches) */
	isSearchActive?: boolean;
	/** True when this commit is in the active review session (D-04 membership marker) */
	inSession?: boolean;
	/** True when this commit is the transient range-base highlight (D-01 support) */
	isPendingBase?: boolean;
	/** Review-comment count anchored to this commit (line comments + notes).
	 *  Parent zeroes it to enforce the toggle/active gate; badge self-hides at 0. */
	commentCount?: number;
	/** File-status breakdown for the synthetic WIP row (only set when isWip). */
	wipStats?: WipStats;
	/** Diff size for the Diff column. `undefined` = not yet computed (placeholder);
	 *  a present value with zeros = a real empty/binary commit. */
	diffStat?: DiffStat;
}

let {
	commit,
	rowIndex,
	onselect,
	oncontextmenu,
	maxColumns = 1,
	columnWidths,
	columnVisibility,
	selected = false,
	rowHeight = ROW_HEIGHT,
	isSearchMatch = false,
	isCurrentMatch = false,
	isSearchActive = false,
	inSession = false,
	isPendingBase = false,
	commentCount = 0,
	wipStats,
	diffStat,
}: Props = $props();

const dateLabel = $derived(
	relativeLabel(commit.author_timestamp, currentMinute()),
);

const isWip = $derived(commit.oid === "__wip__");
const isStash = $derived(commit.is_stash);
const parsed = $derived(parseSummary(commit.summary));

// Diff column: log-scaled green/red bar fractions + a files-changed tooltip.
// `diffStat === undefined` renders a placeholder, distinct from a real +0 −0.
const diffBar = $derived(
	diffStat
		? diffBarFractions(diffStat.insertions, diffStat.deletions)
		: { addFrac: 0, delFrac: 0 },
);
const diffTitle = $derived(
	diffStat
		? `+${diffStat.insertions} −${diffStat.deletions}, ${diffStat.files_changed} ${diffStat.files_changed === 1 ? "file" : "files"} changed`
		: "",
);

// WIP row file-status badges. Letters/colors/titles come from the shared
// STATUS_BADGES map so they stay in lockstep with FileRow.
const wipFileBadges = $derived.by(() => {
	const stats = wipStats;
	if (!isWip || !stats) return [];
	return WIP_BADGE_ORDER.flatMap(({ key, status }) => {
		const count = stats[key];
		if (count <= 0) return [];
		return [{ ...STATUS_BADGES[status], count }];
	});
});

// D-04 in-session + D-01 pending-base markers: theme-variable inset accents on
// distinct edges so they compose with the background ternaries (and each other)
// without fighting them. Never an inline literal color, never the SVG pipeline.
const reviewMarker = $derived(
	[
		inSession ? "inset 3px 0 0 var(--color-review-row)" : "",
		isPendingBase ? "inset 0 -3px 0 var(--color-review-pending-base)" : "",
	]
		.filter(Boolean)
		.join(", "),
);

// Selected rows get the design's left accent bar; it layers ahead of the review
// markers so an in-session selection still shows its 3px review edge on top.
const rowShadow = $derived(
	[selected ? "inset 2px 0 0 var(--accent)" : "", reviewMarker]
		.filter(Boolean)
		.join(", "),
);
</script>

<div
  data-testid="commit-row"
  role="row"
  tabindex="0"
  class="relative flex items-center cursor-pointer text-[13px]"
  class:hover:bg-[var(--bg-hover)]={!selected && !isCurrentMatch && !isSearchMatch}
  style:height="{rowHeight}px"
  style="color: var(--color-text); {isCurrentMatch ? 'background: var(--color-search-current);' : isSearchMatch ? 'background: var(--color-search-match);' : selected ? 'background: var(--color-selected-row);' : ''} {isSearchActive && !isSearchMatch && !isCurrentMatch ? 'opacity: var(--opacity-search-dim);' : ''} {rowShadow ? `box-shadow: ${rowShadow};` : ''}"
  onclick={(e) => onselect?.(commit.oid, { compare: e.metaKey || e.ctrlKey, range: e.shiftKey })}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect?.(commit.oid); } }}
  oncontextmenu={(e: MouseEvent) => { if (oncontextmenu && !isWip) { e.preventDefault(); oncontextmenu(e, commit); } }}
>
  <!-- Column 1: Branch/Tag refs spacer (SVG overlay handles rendering) -->
  {#if columnVisibility.ref}
    <div class="flex-shrink-0" style="width: {columnWidths.ref}px; padding: 0 {COLUMN_PADDING_X}px;"></div>
  {/if}

  <!-- Column 2: Graph -->
  {#if columnVisibility.graph}
    <div class="relative z-[1] flex items-center flex-shrink-0 overflow-hidden" style="width: {columnWidths.graph}px; padding: 0 {COLUMN_PADDING_X}px;">
    </div>
  {/if}

  <!-- Column 3: Message (flex-1, always visible) + WIP file badges + trailing comment badge -->
  <div class="flex-1 flex items-center gap-2 overflow-hidden" style="padding: 0 {COLUMN_PADDING_X}px;">
    {#if isWip}
      <div data-testid="commit-row-summary" class="flex items-center gap-2 overflow-hidden whitespace-nowrap">
        <span class="overflow-hidden text-ellipsis italic rounded px-2 py-0.5" style="min-width: 6rem; background: var(--bg-2); color: var(--color-text-muted);">{commit.summary}</span>
        {#if wipFileBadges.length}
          <span class="flex items-center gap-2 flex-shrink-0 font-mono text-[11px]">
            {#each wipFileBadges as b}
              <span title={b.title} style="color: {b.color};">{b.letter} {b.count}</span>
            {/each}
          </span>
        {/if}
      </div>
    {:else if isStash}
      <span data-testid="commit-row-summary" class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap italic" style="color: var(--color-text-muted);">{commit.summary}</span>
    {:else}
      <span data-testid="commit-row-summary" class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
      >{#if parsed.prefix}<span style="color: {prefixToneVar(parsed.prefix)};">{parsed.prefix}{parsed.scope}{parsed.bang}</span><span style="color: var(--fg-2);">{": "}</span>{parsed.rest}{:else}{commit.summary}{/if}</span>
    {/if}
    <CommentBadge count={commentCount} />
  </div>

  <!-- Column 4: Diff size — log-scaled add/delete bar + counts. Renders for
       commits, stashes, and the WIP row alike; placeholder while uncomputed. -->
  {#if columnVisibility.diff}
    <div
      data-testid="diff-stat"
      class="flex-shrink-0 flex items-center overflow-hidden"
      style="width: {columnWidths.diff}px; padding: 0 {COLUMN_PADDING_X}px;"
      use:tooltip={diffTitle}
    >
      {#if diffStat && (diffBar.addFrac > 0 || diffBar.delFrac > 0)}
        <!-- The bar is the only mark — no background track. It's sized to the diff
             magnitude (a fraction of the column), left-aligned, and rounded on
             BOTH outer ends. Rounding is applied to the painted end segments
             directly (the first rounds its left, the last its right; a one-sided
             bar rounds both) rather than via overflow-clip on the container —
             WebKit/WKWebView doesn't reliably clip a child background to a
             border-radius, which left the right end square. Green/red split =
             add/delete; exact +X −Y and files-changed are in the tooltip.
             Segments split the bar via flex-grow so their ratio matches exactly. -->
        <div data-testid="diff-stat-bar" class="flex h-1.5 flex-shrink-0" style="width: {(diffBar.addFrac + diffBar.delFrac) * 100}%; min-width: 6px;">
          {#if diffBar.addFrac > 0}
            <span data-diff-seg="add" class="h-full {diffBar.delFrac > 0 ? 'rounded-l-full' : 'rounded-full'}" style="flex: {diffBar.addFrac}; min-width: 1px; background: var(--color-diff-add);"></span>
          {/if}
          {#if diffBar.delFrac > 0}
            <span data-diff-seg="delete" class="h-full {diffBar.addFrac > 0 ? 'rounded-r-full' : 'rounded-full'}" style="flex: {diffBar.delFrac}; min-width: 1px; background: var(--color-diff-delete);"></span>
          {/if}
        </div>
      {:else if diffStat && diffStat.files_changed > 0}
        <!-- Files changed but zero line deltas: binary, pure rename, or mode-only.
             A neutral marker keeps "something changed" visible instead of a blank
             gap that reads as "no change". Details are in the tooltip. -->
        <span data-testid="diff-stat-neutral" class="h-1.5 flex-shrink-0 rounded-full" style="width: 6px; background: var(--color-text-muted);"></span>
      {:else if diffStat}
        <!-- Genuinely empty commit (0 files): render nothing — there is no change
             to convey. Distinct from the uncomputed placeholder below. -->
      {:else}
        <span data-testid="diff-stat-placeholder" class="flex-1 text-center text-[11px]" style="color: var(--color-text-muted); opacity: 0.5;">—</span>
      {/if}
    </div>
  {/if}

  <!-- Column 5: Author -->
  {#if columnVisibility.author}
    <div class="flex-shrink-0 flex items-center gap-2 text-[12px]" style="width: {columnWidths.author}px; color: var(--color-text-muted); padding: 0 {COLUMN_PADDING_X}px;">
      {#if !isWip && !isStash}<Avatar name={commit.author_name} /><span class="overflow-hidden text-ellipsis whitespace-nowrap">{commit.author_name}</span>{/if}
    </div>
  {/if}

  <!-- Column 6: Date -->
  {#if columnVisibility.date}
    <div class="flex-shrink-0 overflow-hidden whitespace-nowrap text-[11px]" style="width: {columnWidths.date}px; color: var(--color-text-muted); padding: 0 {COLUMN_PADDING_X}px;">
      {#if !isWip && !isStash}{dateLabel}{/if}
    </div>
  {/if}

  <!-- Column 7: SHA — click to copy the full oid (stops row select on click + keydown) -->
  {#if columnVisibility.sha}
    <div class="flex-shrink-0" style="width: {columnWidths.sha}px; padding: 0 {COLUMN_PADDING_X}px;">
      {#if !isWip && !isStash}
        <button
          type="button"
          title="Copy SHA"
          class="font-mono text-[11px] w-full text-left bg-transparent border-0 p-0 cursor-pointer hover:underline"
          style="color: var(--color-text-muted);"
          onclick={(e) => { e.stopPropagation(); copySha(commit.oid); }}
          onkeydown={(e) => e.stopPropagation()}
        >{commit.short_oid}</button>
      {/if}
    </div>
  {/if}
</div>
