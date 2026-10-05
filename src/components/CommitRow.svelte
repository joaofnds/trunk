<script lang="ts">
import { copySha } from "../lib/clipboard.js";
import { MESSAGE_FLOOR } from "../lib/column-widths.js";
import { parseSummary, prefixToneVar } from "../lib/commit-prefix.js";
import type { SelectModifiers } from "../lib/compare-select.js";
import { diffBarFractions } from "../lib/diff-stat.js";
import { exactDate } from "../lib/exact-date.js";
import { COLUMN_PADDING_X, ROW_HEIGHT } from "../lib/graph-constants.js";
import { currentMinute } from "../lib/now.svelte.js";
import { relativeLabel } from "../lib/relative-time.js";
import { STATUS_BADGES, WIP_BADGE_ORDER } from "../lib/status-badges.js";
import type { ColumnVisibility } from "../lib/store.js";
import { cutTooltip, tooltip } from "../lib/tooltip.js";
import type {
	DiffStat,
	GraphCommit,
	ReviewTone,
	WipStats,
} from "../lib/types.js";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Avatar from "./Avatar.svelte";
import CommentBadge from "./CommentBadge.svelte";

interface Props {
	commit: GraphCommit;
	rowIndex: number;
	onselect?: (oid: string, mods?: SelectModifiers) => void;
	oncontextmenu?: (e: MouseEvent, commit: GraphCommit) => void;
	onenter?: () => void;
	onleave?: () => void;
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
	commentTone?: ReviewTone | null;
	/** File-status breakdown for the synthetic WIP row (only set when isWip). */
	wipStats?: WipStats;
	/** Diff size for the Diff column. `undefined` = not yet computed (placeholder);
	 *  a present value with zeros = a real empty/binary commit. */
	diffStat?: DiffStat;
	/** How far the Message pan has moved the summary's text left, in px. */
	messageScrollX?: number;
}

let {
	commit,
	rowIndex,
	onselect,
	oncontextmenu,
	onenter,
	onleave,
	columnVisibility,
	selected = false,
	rowHeight = ROW_HEIGHT,
	isSearchMatch = false,
	isCurrentMatch = false,
	isSearchActive = false,
	inSession = false,
	isPendingBase = false,
	commentCount = 0,
	commentTone = null,
	wipStats,
	diffStat,
	messageScrollX = 0,
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
		inSession ? "inset 3px 0 0 var(--color-accent)" : "",
		isPendingBase ? "inset 0 -3px 0 var(--color-warning)" : "",
	]
		.filter(Boolean)
		.join(", "),
);

// Selected rows get the design's left accent bar; it layers ahead of the review
// markers so an in-session selection still shows its 3px review edge on top.
const rowShadow = $derived(
	[selected ? "inset 2px 0 0 var(--color-accent)" : "", reviewMarker]
		.filter(Boolean)
		.join(", "),
);
</script>

<!-- Sized cells read their widths from the properties CommitGraph declares on the list
     root; mounted outside it, every sized cell collapses to its content. -->
<div
	data-testid="commit-row"
	role="option"
	aria-selected={selected}
	tabindex="0"
	class="relative flex items-center cursor-pointer text-body text-text"
	class:hover:bg-hover={!selected && !isCurrentMatch && !isSearchMatch}
	class:bg-search-current={isCurrentMatch}
	class:bg-search-match={isSearchMatch && !isCurrentMatch}
	class:bg-selected-row={selected && !isSearchMatch && !isCurrentMatch}
	class:search-dim={isSearchActive && !isSearchMatch && !isCurrentMatch}
	style:height="{rowHeight}px"
	style:box-shadow={rowShadow}
	onclick={(e) => onselect?.(commit.oid, { compare: e.metaKey || e.ctrlKey, range: e.shiftKey })}
	onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect?.(commit.oid); } }}
	oncontextmenu={(e: MouseEvent) => { if (oncontextmenu && !isWip) { e.preventDefault(); oncontextmenu(e, commit); } }}
	onmouseenter={() => onenter?.()}
	onmouseleave={() => onleave?.()}
>
	<!-- Column 1: Branch/Tag refs spacer (SVG overlay handles rendering) -->
	{#if columnVisibility.ref}
		<div
			data-column="ref"
			class="flex-shrink-0"
			style:padding="0 {COLUMN_PADDING_X}px"
		></div>
	{/if}

	<!-- Column 2: Graph -->
	{#if columnVisibility.graph}
		<div
			data-column="graph"
			class="relative z-1 flex items-center flex-shrink-0 overflow-hidden"
			style:padding="0 {COLUMN_PADDING_X}px"
		> </div>
	{/if}

	<!-- Column 3: Message (flex-1, always visible) + WIP file badges + trailing comment badge -->
	<div
		data-column="message"
		class="flex-1 flex items-center gap-2 overflow-hidden"
		style:padding="0 {COLUMN_PADDING_X}px"
		style:min-width="{MESSAGE_FLOOR}px"
	>
		{#if isWip}
			<div
				data-testid="commit-row-summary"
				class="flex items-center gap-2 overflow-hidden whitespace-nowrap"
			>
				<span
					class="wip-summary overflow-hidden text-ellipsis italic rounded px-2 py-1 bg-surface-raised text-text-muted"
					>{commit.summary}</span
				>
				{#if wipFileBadges.length}
					<span
						class="flex items-center gap-2 flex-shrink-0 font-mono text-small"
					>
						{#each wipFileBadges as b}
							<span title={b.title} style:color={b.color}
								>{b.letter} {b.count}</span
							>
						{/each}
					</span>
				{/if}
			</div>
		{:else if isStash}
			<span
				data-testid="commit-row-summary"
				data-message-summary
				class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap italic text-text-muted"
				use:cutTooltip={commit.summary}
				><span style:margin-left="{-messageScrollX}px"
					>{commit.summary}</span
				></span
			>
		{:else}
			<span
				data-testid="commit-row-summary"
				data-message-summary
				class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
				use:cutTooltip={commit.summary}
				><span style:margin-left="{-messageScrollX}px"
					>{#if parsed.prefix}
						<span style:color={prefixToneVar(parsed.prefix)}
							>{parsed.prefix}{parsed.scope}{parsed.bang}</span
						><span class="prefix-colon">{": "}</span>{parsed.rest}
					{:else}
						{commit.summary}
					{/if}</span
				></span
			>
		{/if}
		<CommentBadge count={commentCount} tone={commentTone} />
	</div>

	<!-- Column 4: Diff size — log-scaled add/delete bar + counts. Renders for
       commits, stashes, and the WIP row alike; placeholder while uncomputed. -->
	{#if columnVisibility.diff}
		<div
			data-testid="diff-stat"
			data-column="diff"
			class="flex-shrink-0 flex items-center overflow-hidden"
			style:padding="0 {COLUMN_PADDING_X}px"
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
				<div
					data-testid="diff-stat-bar"
					class="flex h-1 min-w-1 flex-shrink-0"
					style:width="{(diffBar.addFrac + diffBar.delFrac) * 100}%"
				>
					{#if diffBar.addFrac > 0}
						<span
							data-diff-seg="add"
							class="h-full min-w-px bg-diff-add {diffBar.delFrac > 0 ? 'rounded-l-full' : 'rounded-full'}"
							style:flex={diffBar.addFrac}
						></span>
					{/if}
					{#if diffBar.delFrac > 0}
						<span
							data-diff-seg="delete"
							class="h-full min-w-px bg-diff-delete {diffBar.addFrac > 0 ? 'rounded-r-full' : 'rounded-full'}"
							style:flex={diffBar.delFrac}
						></span>
					{/if}
				</div>
			{:else if diffStat && diffStat.files_changed > 0}
				<!-- Files changed but zero line deltas: binary, pure rename, or mode-only.
             A neutral marker keeps "something changed" visible instead of a blank
             gap that reads as "no change". Details are in the tooltip. -->
				<span
					data-testid="diff-stat-neutral"
					class="h-1 w-1 flex-shrink-0 rounded-full bg-text-muted"
				></span>
			{:else if diffStat}
			<!-- Genuinely empty commit (0 files): render nothing — there is no change
             to convey. Distinct from the uncomputed placeholder below. -->
			{:else}
				<span
					data-testid="diff-stat-placeholder"
					class="flex-1 text-center text-small text-text-muted opacity-50"
					>—</span
				>
			{/if}
		</div>
	{/if}

	<!-- Column 5: Author -->
	{#if columnVisibility.author}
		<div
			data-column="author"
			class="flex-shrink-0 flex items-center text-callout text-text-muted"
			style:padding="0 {COLUMN_PADDING_X}px"
		>
			{#if !isWip && !isStash}
				<span
					data-testid="commit-author"
					class="flex items-center gap-2 min-w-0 w-full"
					use:cutTooltip={commit.author_name}
					><Avatar name={commit.author_name} />
					<span class="overflow-hidden text-ellipsis whitespace-nowrap"
						>{commit.author_name}</span
					></span
				>
			{/if}
		</div>
	{/if}

	<!-- Column 6: Date -->
	{#if columnVisibility.date}
		<div
			data-column="date"
			class="flex-shrink-0 overflow-hidden whitespace-nowrap text-small text-text-muted"
			style:padding="0 {COLUMN_PADDING_X}px"
		>
			{#if !isWip && !isStash}
				<span data-testid="commit-date" use:exactDate={commit.author_timestamp}
					>{dateLabel}</span
				>
			{/if}
		</div>
	{/if}

	<!-- Column 7: SHA — click to copy the full oid (stops row select on click + keydown) -->
	{#if columnVisibility.sha}
		<div
			data-column="sha"
			class="flex-shrink-0 overflow-hidden whitespace-nowrap text-small"
			style:padding="0 {COLUMN_PADDING_X}px"
		>
			{#if !isWip && !isStash}
				<LinkButton
					mono
					truncate
					tone="muted"
					title="Copy SHA"
					onclick={(e) => { e.stopPropagation(); copySha(commit.oid); }}
					onkeydown={(e) => e.stopPropagation()}
					>{commit.short_oid}</LinkButton
				>
			{/if}
		</div>
	{/if}
</div>

<style>
.prefix-colon {
	color: var(--color-text-muted);
}

/* A row the open search did not match steps back so the matches read first. */
.search-dim {
	opacity: var(--opacity-search-dim);
}

/* Wide enough that a one-word WIP summary still reads as a chip. */
.wip-summary {
	min-width: calc(24 * var(--u));
}
</style>
