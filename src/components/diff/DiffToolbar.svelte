<script lang="ts">
import ChevronLeft from "@lucide/svelte/icons/chevron-left";
import Code2 from "@lucide/svelte/icons/code-2";
import Columns2 from "@lucide/svelte/icons/columns-2";
import Eye from "@lucide/svelte/icons/eye";
import FoldVertical from "@lucide/svelte/icons/fold-vertical";
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import Rows2 from "@lucide/svelte/icons/rows-2";
import Space from "@lucide/svelte/icons/space";
import Trash2 from "@lucide/svelte/icons/trash-2";
import UnfoldVertical from "@lucide/svelte/icons/unfold-vertical";
import X from "@lucide/svelte/icons/x";
import { onMount } from "svelte";
import type { PanelDiffKind } from "../../lib/comment-matching.js";
import { fileStatusOf } from "../../lib/file-status.js";
import { isMarkdownPath } from "../../lib/markdown.js";
import { DIFF_ROW_FONT, measureRowMetrics } from "../../lib/row-metrics.js";
import { singleClick } from "../../lib/single-click.js";
import {
	STATUS_BADGES,
	UNKNOWN_STATUS_BADGE,
} from "../../lib/status-badges.js";
import type {
	ContentMode,
	DiffStatus,
	LayoutMode,
	RenderMode,
	ReviewTally,
} from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";
import CommentBadge from "../CommentBadge.svelte";
import FilePathLabel from "../FilePathLabel.svelte";
import DiffTextControls from "./DiffTextControls.svelte";

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
	takesComments: boolean;
	byteEscapedPath?: boolean;
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
	showsLines?: boolean;
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
	takesComments,
	byteEscapedPath = false,
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
	showsLines = true,
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

const badge = $derived(
	selectedStatus === null
		? null
		: (STATUS_BADGES[fileStatusOf(selectedStatus)] ?? UNKNOWN_STATUS_BADGE),
);

const whitespaceHidesLines = $derived(ignoreWhitespace && showsLines);

const commentCount = $derived(
	Object.values(commentTally ?? {}).reduce((sum, n) => sum + n, 0),
);

const renderedActive = $derived(
	renderMode === "rendered" &&
		selectedPath !== null &&
		isMarkdownPath(selectedPath),
);

// Unmeasured until the observer first reports, so the actions keep their words.
let toolbarWidth = $state(Number.POSITIVE_INFINITY);

function observeToolbarWidth(toolbar: HTMLElement) {
	const observer = new ResizeObserver((entries) => {
		for (const entry of entries) toolbarWidth = entry.contentRect.width;
	});
	observer.observe(toolbar);
	return () => observer.disconnect();
}

// Each is the width the toolbar's worded actions take, the markdown toggle
// among them, plus about 96px of file name, so the words go a little early
// rather than leave the name no room. The kinds with more of them need more.
function widthForWords(kind: PanelDiffKind, hasWayBack: boolean): number {
	if (kind === "unstaged") return hasWayBack ? 632 : 560;
	if (kind === "staged") return hasWayBack ? 560 : 488;
	return hasWayBack ? 488 : 400;
}

// Where the pane is too narrow for the worded actions beside a readable file
// name, each is drawn as its glyph and keeps its words as its name and its
// tooltip. Drawn with its words, it has no tooltip to repeat them.
const compact = $derived(
	toolbarWidth < widthForWords(diffKind, backLabel !== null),
);
</script>

<div class="toolbar" {@attach observeToolbarWidth}>
	{#if backLabel !== null}
		<Button
			icon={compact}
			size="sm"
			variant="ghost"
			aria-label={backLabel}
			title={compact ? backLabel : undefined}
			onclick={onclose}
		>
			{#if compact}
				<ChevronLeft size={14} aria-hidden="true" />
			{:else}
				<ChevronLeft size={12} aria-hidden="true" />
				{backLabel}
			{/if}
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
		{#if selectedPath !== null}
			<span
				class="flex min-w-0"
				data-testid="diff-path"
				data-path={selectedPath}
			>
				<FilePathLabel path={selectedPath} oldPath={selectedOldPath} />
			</span>
		{/if}
		<CommentBadge count={commentCount} tally={commentTally} />
	</span>

	<!-- One-click whole-file Comment (260531-l02e/l02f): comments every change in the
       file in one click. Available for every diff kind the store can anchor a thread
       against — commit diffs as well as the dirty tree (selectedPath is always set
       when this toolbar renders). A current-file view is excluded: commenting on
       one is a line selection, since a whole-file pin would go stale on any edit
       anywhere in the file. Gated on takesComments like the hunk
       toolbar's Comment buttons, so a clean read-only diff shows no comment
       affordances; never gated on whitespace-ignore since it never stages. It
       sits right after the file name, which gives up the width it takes, so its
       arrival moves no other control. -->
	{#if takesComments && diffKind !== "current_file"}
		<Button
			icon={compact}
			size="sm"
			variant="accent"
			aria-label="Comment File"
			disabled={byteEscapedPath}
			title={byteEscapedPath
				? "Comments require a UTF-8 file path"
				: compact
					? "Comment File"
					: undefined}
			onclick={oncommentfile}
		>
			{#if compact}
				<MessageSquarePlus size={14} aria-hidden="true" />
			{:else}
				Comment File
			{/if}
		</Button>
	{/if}

	{#if selectedPath && isMarkdownPath(selectedPath)}
		<Button
			icon
			size="sm"
			variant="ghost"
			disabled={byteEscapedPath}
			title={byteEscapedPath
				? "Markdown previews require a UTF-8 file path"
				: renderMode === "source"
					? "Show rendered markdown"
					: "Show source"}
			onclick={() =>
				onrendermodechange(renderMode === "source" ? "rendered" : "source")}
		>
			{#if renderMode === "source"}
				<Eye size={14} />
			{:else}
				<Code2 size={14} />
			{/if}
		</Button>
	{/if}

	{#if showsLines}
		{#if diffKind !== "current_file"}
			<Button
				icon
				size="sm"
				variant="ghost"
				title={contentMode === "hunk" ? "Show full file" : "Show hunks"}
				onclick={() =>
					oncontentmodechange(contentMode === "hunk" ? "full" : "hunk")}
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
			onclick={() =>
				onlayoutmodechange(layoutMode === "inline" ? "split" : "inline")}
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
		<DiffTextControls
			{showInvisibles}
			{wordWrap}
			{fixedPitch}
			{renderedActive}
			{onshowinvisibleschange}
			{onwordwrapchange}
		/>
	{/if}
	<span
		class="font-probe"
		bind:this={fontProbe}
		style:font-family={DIFF_ROW_FONT.fontFamily}
		style:font-size={DIFF_ROW_FONT.fontSize}
		style:line-height={DIFF_ROW_FONT.lineHeight}
	></span>

	{#if diffKind === "unstaged"}
		<Button
			icon={compact}
			size="sm"
			variant="danger"
			disabled={hunkOperationInFlight}
			aria-label="Discard File"
			title={compact ? "Discard File" : undefined}
			onclick={ondiscardfile}
		>
			{#if compact}
				<Trash2 size={14} aria-hidden="true" />
			{:else}
				Discard File
			{/if}
		</Button>
		<Button
			icon={compact}
			size="sm"
			variant="success"
			disabled={hunkOperationInFlight || whitespaceHidesLines}
			title={whitespaceHidesLines
				? "Staging is disabled while whitespace changes are ignored"
				: compact
					? "Stage File"
					: undefined}
			aria-label="Stage File"
			onclick={(e: MouseEvent) => singleClick(e, onstagefile)}
		>
			{#if compact}
				<Plus size={14} aria-hidden="true" />
			{:else}
				Stage File
			{/if}
		</Button>
	{:else if diffKind === "staged"}
		<Button
			icon={compact}
			size="sm"
			variant="warning"
			disabled={hunkOperationInFlight || whitespaceHidesLines}
			title={whitespaceHidesLines
				? "Staging is disabled while whitespace changes are ignored"
				: compact
					? "Unstage File"
					: undefined}
			aria-label="Unstage File"
			onclick={(e: MouseEvent) => singleClick(e, onunstagefile)}
		>
			{#if compact}
				<Minus size={14} aria-hidden="true" />
			{:else}
				Unstage File
			{/if}
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
	overflow: hidden;
	display: flex;
	align-items: baseline;
	gap: var(--space-1);
	font-size: var(--text-small);
	color: var(--color-text);
	text-align: left;
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
