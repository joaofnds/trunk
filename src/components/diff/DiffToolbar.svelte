<script lang="ts">
import ChevronLeft from "@lucide/svelte/icons/chevron-left";
import Code2 from "@lucide/svelte/icons/code-2";
import Columns2 from "@lucide/svelte/icons/columns-2";
import Eye from "@lucide/svelte/icons/eye";
import FoldVertical from "@lucide/svelte/icons/fold-vertical";
import Pilcrow from "@lucide/svelte/icons/pilcrow";
import Rows2 from "@lucide/svelte/icons/rows-2";
import Space from "@lucide/svelte/icons/space";
import TextWrap from "@lucide/svelte/icons/text-wrap";
import UnfoldVertical from "@lucide/svelte/icons/unfold-vertical";
import X from "@lucide/svelte/icons/x";
import { onMount } from "svelte";
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import { fileStatusOf } from "../../lib/file-status.js";
import { isMarkdownPath } from "../../lib/markdown.js";
import { renamePartsOf } from "../../lib/rename-display.js";
import { DIFF_ROW_FONT, measureRowMetrics } from "../../lib/row-metrics.js";
import {
	STATUS_BADGES,
	UNKNOWN_STATUS_BADGE,
} from "../../lib/status-badges.js";
import type {
	ContentMode,
	DiffStatus,
	LayoutMode,
	RenderMode,
	ReviewFilter,
	ReviewTally,
} from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import CommentBadge from "../CommentBadge.svelte";

interface Props {
	contentMode: ContentMode;
	layoutMode: LayoutMode;
	renderMode: RenderMode;
	oncontentmodechange: (mode: ContentMode) => void;
	onlayoutmodechange: (mode: LayoutMode) => void;
	onrendermodechange: (mode: RenderMode) => void;
	selectedPath: string | null;
	selectedStatus?: DiffStatus | null;
	selectedOldPath?: string | null;
	diffKind: PanelDiffKind;
	hunkOperationInFlight: boolean;
	ignoreWhitespace: boolean;
	showInvisibles: boolean;
	wordWrap: boolean;
	reviewCommentsVisible?: boolean;
	reviewFilter?: ReviewFilter;
	/** The selected file's threads the badge counts, by state. */
	commentTally?: ReviewTally | null;
	onignorewhitespacechange: (value: boolean) => void;
	onshowinvisibleschange: (value: boolean) => void;
	onwordwrapchange: (value: boolean) => void;
	onstagefile: () => void;
	onunstagefile: () => void;
	ondiscardfile: () => void;
	oncommentfile: () => void;
	onclose: () => void;
	/** Names the view the diff covers, where closing it returns to. */
	backLabel?: string | null;
}

let {
	contentMode,
	layoutMode,
	renderMode,
	oncontentmodechange,
	onlayoutmodechange,
	onrendermodechange,
	selectedPath,
	selectedStatus = null,
	selectedOldPath = null,
	diffKind,
	hunkOperationInFlight,
	ignoreWhitespace,
	showInvisibles,
	wordWrap,
	reviewCommentsVisible = true,
	reviewFilter = "all",
	commentTally = null,
	onignorewhitespacechange,
	onshowinvisibleschange,
	onwordwrapchange,
	onstagefile,
	onunstagefile,
	ondiscardfile,
	oncommentfile,
	onclose,
	backLabel = null,
}: Props = $props();

// Rendered prose collapses whitespace by nature, so the invisibles toggle
// cannot mean anything while the preview is the active view (renderMode only
// takes effect for markdown files — DiffViewer's routing gate).
// Wrapped-row heights are derived from a column count, which only describes the
// layout when every glyph advances the same width. A toggle that reads as on
// while its effect is off is a lie the UI tells, so the toggle goes away
// instead (P-8).
let fontProbe = $state<HTMLSpanElement | null>(null);
let fixedPitch = $state(true);

onMount(() => {
	if (fontProbe) fixedPitch = measureRowMetrics(fontProbe).monospace;
});

// The header repeats the file list's own badge and rename form so the two
// surfaces name the same change the same way. Both come from the shared
// helpers rather than a second mapping here.
const badge = $derived(
	selectedStatus === null
		? null
		: (STATUS_BADGES[fileStatusOf(selectedStatus)] ?? UNKNOWN_STATUS_BADGE),
);

const rename = $derived(
	selectedPath === null ? null : renamePartsOf(selectedPath, selectedOldPath),
);

const commentCount = $derived(
	reviewCommentsVisible && reviewFilter !== "none"
		? Object.values(commentTally ?? {}).reduce((sum, n) => sum + n, 0)
		: 0,
);

const renderedActive = $derived(
	renderMode === "rendered" &&
		selectedPath !== null &&
		isMarkdownPath(selectedPath),
);
</script>

<div class="toolbar">
	{#if backLabel !== null}
		<Button size="sm" variant="ghost" onclick={onclose}>
			<ChevronLeft size={12} aria-hidden="true" />{backLabel}
		</Button>
	{/if}
	{#if badge !== null}
		<span
			data-testid="diff-status-badge"
			class="status-badge"
			title={badge.title}
			style:color={badge.color}
			style:background="color-mix(in oklch, {badge.color} 6%, transparent)"
			>{badge.letter}</span
		>
	{/if}

	<span class="filename">
		{#if rename !== null}
			<!-- The old path yields space first, matching FileRow: it shrinks and
           ellipsizes while the new path keeps its width. -->
			<span data-testid="diff-old-path" class="old-path">{rename.from}</span>
			<span aria-hidden="true" class="rename-arrow">&rarr;</span>
			<span data-testid="diff-path" class="new-path">{rename.to}</span>
		{:else if selectedPath}
			<span data-testid="diff-path" class="new-path">{selectedPath}</span>
		{/if}
		<CommentBadge count={commentCount} tally={commentTally} />
	</span>

	{#if selectedPath && isMarkdownPath(selectedPath)}
		<Button
			icon
			size="sm"
			variant="ghost"
			aria-pressed={renderMode === "rendered"}
			title={renderMode === "source" ? "Show rendered markdown" : "Show source"}
			onclick={() => onrendermodechange(renderMode === "source" ? "rendered" : "source")}
		>
			{#if renderMode === "source"}
				<Eye size={14} />
			{:else}
				<Code2 size={14} />
			{/if}
		</Button>
	{/if}

	{#if diffKind !== "current_file"}
		<Button
			icon
			size="sm"
			variant="ghost"
			title={contentMode === "hunk" ? "Show full file" : "Show hunks"}
			onclick={() => oncontentmodechange(contentMode === "hunk" ? "full" : "hunk")}
		>
			{#if contentMode === "hunk"}
				<UnfoldVertical size={14} />
			{:else}
				<FoldVertical size={14} />
			{/if}
		</Button>
	{/if}

	<Button
		icon
		size="sm"
		variant="ghost"
		title={layoutMode === "inline" ? "Side-by-side view" : "Inline view"}
		onclick={() => onlayoutmodechange(layoutMode === "inline" ? "split" : "inline")}
	>
		{#if layoutMode === "inline"}
			<Columns2 size={14} />
		{:else}
			<Rows2 size={14} />
		{/if}
	</Button>

	<Button
		icon
		size="sm"
		variant="ghost"
		aria-pressed={ignoreWhitespace}
		title="Ignore whitespace changes"
		onclick={() => onignorewhitespacechange(!ignoreWhitespace)}
	>
		<Space size={14} />
	</Button>
	<Button
		icon
		size="sm"
		variant="ghost"
		aria-pressed={showInvisibles}
		disabled={renderedActive}
		title={renderedActive
      ? "Invisible characters aren't rendered in preview"
      : "Show invisible characters"}
		onclick={() => onshowinvisibleschange(!showInvisibles)}
	>
		<Pilcrow size={14} />
	</Button>
	<Button
		icon
		size="sm"
		variant="ghost"
		aria-pressed={wordWrap}
		disabled={!fixedPitch}
		title={fixedPitch
      ? "Toggle word wrap"
      : "Word wrap needs a fixed-pitch diff font"}
		onclick={() => onwordwrapchange(!wordWrap)}
	>
		<TextWrap size={14} />
	</Button>
	<span
		class="font-probe"
		bind:this={fontProbe}
		style:font-family={DIFF_ROW_FONT.fontFamily}
		style:font-size={DIFF_ROW_FONT.fontSize}
		style:line-height={DIFF_ROW_FONT.lineHeight}
	></span>

	<!-- One-click whole-file Comment (260531-l02e/l02f): comments every change in the
       file in one click. Available for every diff kind the store can anchor a thread
       against — commit diffs as well as the dirty tree (selectedPath is always set
       when this toolbar renders). A current-file view is excluded: commenting on
       one is a line selection, since a whole-file pin would go stale on any edit
       anywhere in the file. Gated on review mode (reviewCommentsVisible) like the hunk
       toolbar's Comment buttons, so a clean read-only diff shows no comment
       affordances; never gated on whitespace-ignore since it never stages. -->
	{#if reviewCommentsVisible && reviewFilter !== "none" && diffKind !== "current_file"}
		<Button size="sm" variant="accent" onclick={oncommentfile}
			>Comment File</Button
		>
	{/if}

	{#if diffKind === 'unstaged'}
		<Button
			size="sm"
			variant="danger"
			disabled={hunkOperationInFlight}
			onclick={ondiscardfile}
		>
			Discard File
		</Button>
		<Button
			size="sm"
			variant="success"
			disabled={hunkOperationInFlight || ignoreWhitespace}
			title={ignoreWhitespace ? "Staging is disabled while whitespace changes are ignored" : undefined}
			onclick={onstagefile}
		>
			Stage File
		</Button>
	{:else if diffKind === 'staged'}
		<Button
			size="sm"
			variant="warning"
			disabled={hunkOperationInFlight || ignoreWhitespace}
			title={ignoreWhitespace ? "Staging is disabled while whitespace changes are ignored" : undefined}
			onclick={onunstagefile}
		>
			Unstage File
		</Button>
	{/if}

	<Button
		icon
		size="sm"
		variant="ghost"
		aria-label="Close diff"
		onclick={onclose}
	>
		<X size={14} />
	</Button>
</div>

<style>
.font-probe {
	position: absolute;
	visibility: hidden;
	pointer-events: none;
}

.toolbar {
	height: var(--bar-h);
	box-shadow: inset 0 -1px 0 var(--color-border);
	padding: 0 var(--space-2);
	display: flex;
	align-items: center;
	flex-shrink: 0;
	gap: var(--space-1);
}

.filename {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: var(--space-1);
	font-size: var(--text-small);
	color: var(--color-text-muted);
	text-align: left;
}

.old-path {
	flex-shrink: 1;
	min-width: 2ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.rename-arrow {
	flex-shrink: 0;
}

.new-path {
	flex-shrink: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.status-badge {
	flex-shrink: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: calc(4 * var(--u));
	height: calc(4 * var(--u));
	border-radius: var(--radius);
	font-family: var(--font-mono);
	font-weight: var(--weight-semibold);
	font-size: var(--text-caption);
	line-height: var(--leading-none);
}
</style>
