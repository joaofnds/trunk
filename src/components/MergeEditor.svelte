<script lang="ts">
import Check from "@lucide/svelte/icons/check";
import CheckCheck from "@lucide/svelte/icons/check-check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import CircleX from "@lucide/svelte/icons/circle-x";
import FoldVertical from "@lucide/svelte/icons/fold-vertical";
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
import UnfoldVertical from "@lucide/svelte/icons/unfold-vertical";
import X from "@lucide/svelte/icons/x";
import { onDestroy, tick, untrack } from "svelte";
import { ask } from "../lib/dialog.js";
import { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import { trailingWhitespaceStart } from "../lib/diff-utils.js";
import { flattened } from "../lib/display-text.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { showFilePathMenu } from "../lib/file-menu.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import { focusInEditable, keyChord } from "../lib/keyboard.js";
import {
	countUnresolved,
	getConflictIndices,
	lineEndingOf,
	outputRegions,
	sideKeys,
	takeAllCurrent,
	takeAllIncoming,
	toggleHunk,
	toggleLine,
} from "../lib/merge-parser.js";
import { createMergePicks, type MergePicksStore } from "../lib/merge-picks.js";
import { conflictNearest, mapOffset } from "../lib/merge-scroll.js";
import {
	buildMergeSideRows,
	CONFLICT_HEADER_HEIGHT,
	type MergeSideRow as FlatRow,
	MERGE_LINE_HEIGHT as LINE_HEIGHT,
	type MergeSide,
	mergeLineHeight,
	mergeScrollLayouts,
	reflowedSideTop,
	type SideLine,
} from "../lib/merge-side-rows.js";
import { measureRowMetrics, type RowMetrics } from "../lib/row-metrics.js";
import type { MergedSpan, MergeSides } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import LinkButton from "../lib/ui/LinkButton.svelte";
import Row from "../lib/ui/Row.svelte";
import { registerUpdateBlocker } from "../lib/updates-context.js";
import { windowFor } from "../lib/virtual-window.js";
import DiffTextControls from "./diff/DiffTextControls.svelte";
import FilePathLabel from "./FilePathLabel.svelte";
import MergeOutput from "./MergeOutput.svelte";
import MergeText from "./MergeText.svelte";

interface Props {
	diffPreferences?: DiffPreferences;
	keysActive?: boolean;
	repoPath: string;
	filePath: string;
	onclose: () => void;
	onresolved: () => void;
	picks?: MergePicksStore;
}

let {
	diffPreferences = DiffPreferences.defaults(),
	keysActive = true,
	repoPath,
	filePath,
	onclose,
	onresolved,
	picks = createMergePicks(),
}: Props = $props();

let fullFile = $state(true);
const contextToggleLabel = $derived(
	fullFile ? "Show conflicts with context" : "Show full file",
);

function handleMergeKeydown(event: KeyboardEvent) {
	if (
		!keysActive ||
		event.defaultPrevented ||
		event.isComposing ||
		loading ||
		!displayed ||
		saving
	)
		return;
	const chord = keyChord(event);
	if (chord !== "[" && chord !== "]") return;
	if (
		focusInEditable(document.activeElement) ||
		document.querySelector("dialog[open]")
	)
		return;
	event.preventDefault();
	if (chord === "[") handlePrevConflict();
	else handleNextConflict();
}

function openPathMenu(event: MouseEvent) {
	event.preventDefault();
	if (!displayed || loading) return;
	const anchor =
		event.type === "click" &&
		event.detail === 0 &&
		event.currentTarget instanceof HTMLElement
			? event.currentTarget.getBoundingClientRect()
			: undefined;
	void showFilePathMenu({
		repoPath: displayed.repo,
		path: displayed.path,
		anchor,
	}).catch((e) => reportErrorToast(e, "Could not open path menu"));
}

// ---------- Constants ----------
const SIDE_LABEL = {
	ours: "Current (Ours)",
	theirs: "Incoming (Theirs)",
} as const;

// ---------- State ----------
// The displayed path, sides and drafts change together when the selected file is ready.
type FileView = { repo: string; path: string } & (
	| { kind: "ready"; sides: MergeSides; signature: string }
	| { kind: "error"; message: string; retryable: boolean }
);
let view = $state.raw<FileView | null>(null);
let displayed = $derived(view?.kind === "ready" ? view : null);
let sources = $derived(displayed?.sides);
let regions = $derived(sources?.regions ?? []);
let loadVersion = 0;
onDestroy(() => {
	loadVersion++;
});
let takenLines = $state<Set<string>>(new Set());
let manualEdit = $state(false);
let manualText = $state("");
let loading = $state(true);
// A binary, deleted or linked side is a fact about the file, so loading it again
// gets the same refusal, and a Retry button there would only promise otherwise.
const UNRESOLVABLE_HERE: ReadonlySet<string> = new Set([
	"binary_conflict",
	"delete_conflict",
	"link_conflict",
]);
let focusedConflictIdx = $state(0);
let saving = $state(false);
type BaseView = { scope: "conflict" | "file"; text: string };
let baseView = $state.raw<{
	number: number;
	opener: HTMLElement;
	content?: BaseView;
	error?: string;
} | null>(null);

async function showBase(row: FlatRow, opener: HTMLElement) {
	const region = regions[row.regionIdx];
	const baseOid = sources?.base_oid;
	if (loading || !displayed || !baseOid || region?.type !== "conflict") return;
	const request = { number: row.conflictNum, opener };
	baseView = request;
	try {
		const content = await safeInvoke<BaseView>("get_merge_base", {
			path: displayed.repo,
			filePath: displayed.path,
			baseOid,
			selection: {
				ordinal: row.conflictNum - 1,
				ours: region.oursLines,
				theirs: region.theirsLines,
			},
		});
		if (baseView === request) baseView = { ...request, content };
	} catch (e) {
		if (baseView === request)
			baseView = {
				...request,
				error: errorMessage(e, "Could not read the merge base"),
			};
	}
}

function closeBase() {
	const opener = baseView?.opener;
	baseView = null;
	tick().then(() => {
		if (opener?.isConnected) opener.focus({ preventScroll: true });
	});
}

let panelRefs = $state<HTMLElement[]>([]);
let panelScrollTop = $state(0);
let panelViewportHeight = $state(400);

let probe = $state<HTMLElement>();
let oursWidth = $state(0);
let theirsWidth = $state(0);
let metrics = $state.raw<RowMetrics>();
$effect(() => {
	if (probe) metrics = measureRowMetrics(probe);
});
let sideWrapAvailable = $derived(metrics?.monospace ?? true);
let sideWrap = $derived(diffPreferences.wordWrap && sideWrapAvailable);
let sideColumns = $derived(
	sideWrap && metrics?.charWidthPx && oursWidth > 0 && theirsWidth > 0
		? Math.max(
				1,
				Math.floor(Math.min(oursWidth, theirsWidth) / metrics.charWidthPx),
			)
		: 0,
);
// Only visible lines are measured. Keep offscreen estimates until a font's
// glyph widths or inline syntax boundaries give a different browser height.
let measured = $derived.by(() => {
	void regions;
	void oursWidth;
	void theirsWidth;
	void sideColumns;
	void diffPreferences.showInvisibles;
	return new Map<string, number>();
});
let measurementVersion = $state(0);
const watched = new WeakMap<
	Element,
	{ key: string; estimate: number; cache: Map<string, number> }
>();
let heightObserver: ResizeObserver | undefined;
function watchWrap(node: HTMLElement, initialKey: string) {
	let key = $state(initialKey);
	$effect(() => {
		if (!sideColumns) return;
		watched.set(node, {
			key,
			estimate: mergeLineHeight(node.textContent ?? "", sideColumns),
			cache: measured,
		});
		heightObserver ??= new ResizeObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				const line = watched.get(entry.target);
				if (!line || !entry.target.isConnected) continue;
				const height = Math.max(LINE_HEIGHT, entry.contentRect.height);
				if ((line.cache.get(line.key) ?? line.estimate) === height) continue;
				if (height === line.estimate) line.cache.delete(line.key);
				else line.cache.set(line.key, height);
				changed = true;
			}
			if (changed) measurementVersion++;
		});
		heightObserver.observe(node);
		return () => {
			heightObserver?.unobserve(node);
			watched.delete(node);
		};
	});
	return {
		update(next: string) {
			key = next;
		},
	};
}
onDestroy(() => heightObserver?.disconnect());

let outputColumns = $state(0);
let expandedGaps = $derived.by(() => {
	void fullFile;
	void regions;
	return new Set<number>();
});

// ---------- Derived ----------
let conflictIndices = $derived(getConflictIndices(regions));
let outputLines = $derived(outputRegions(regions, takenLines));
let outputText = $derived(
	manualEdit ? manualText : outputLines.flat().join("\n"),
);
let hasPrev = $derived(focusedConflictIdx > 0);
let hasNext = $derived(focusedConflictIdx < conflictIndices.length - 1);
let hasConflicts = $derived(conflictIndices.length > 0);
let unresolved = $derived(countUnresolved(regions, takenLines));
let needsReview = $derived(manualEdit && unresolved > 0);

let aligned = $derived.by(() => {
	void measurementVersion;
	return buildMergeSideRows(
		regions,
		fullFile ? null : diffPreferences.contextLines,
		expandedGaps,
		sideColumns,
		measured,
	);
});
let visible = $derived(
	windowFor(
		aligned.offsets,
		panelScrollTop,
		panelViewportHeight,
		20 * LINE_HEIGHT,
	),
);
let scrollLayouts = $derived(
	manualEdit ? null : mergeScrollLayouts(aligned, outputLines, outputColumns),
);
let headerCentres = $derived(
	conflictIndices.map(
		(r) => aligned.regionTops[r] + CONFLICT_HEADER_HEIGHT / 2,
	),
);

// ---------- Data loading ----------
const sourcePath = $derived(filePath);
const sourceRepo = $derived(repoPath);
$effect(() => {
	const path = sourcePath;
	const repo = sourceRepo;
	untrack(() => loadSides({ repo, path }));
});

$effect(() => {
	const picked = { taken: takenLines, typed: manualEdit ? manualText : null };
	if (displayed)
		picks.set(displayed.repo, displayed.path, displayed.signature, picked);
});

// A reply for a file the editor has since moved off is dropped. A file that is
// no longer conflicted (a reset, or a resolve from elsewhere) closes the editor;
// any other failure, a binary side among them, stays on screen with its reason.
function loadSides({ repo, path }: { repo: string; path: string }) {
	const version = ++loadVersion;
	baseView = null;
	loading = true;
	if (view?.repo !== repo) view = null;

	safeInvoke<MergeSides>("get_merge_sides", { path: repo, filePath: path })
		.then((result) => {
			if (version !== loadVersion || path !== filePath || repo !== repoPath)
				return;

			const signature = JSON.stringify([result.revision, result.regions]);
			const kept = picks.get(repo, path, signature);
			view = { kind: "ready", repo, path, sides: result, signature };
			takenLines = new Set(kept?.taken);
			lastClickedKey = null;
			manualEdit = kept?.typed != null;
			manualText = kept?.typed ?? "";
			focusedConflictIdx = 0;
			panelScrollTop = 0;
			loading = false;
			tick().then(() => scrollToConflict(0));
		})
		.catch((e) => {
			if (version !== loadVersion || path !== filePath || repo !== repoPath)
				return;

			if (isTrunkError(e) && e.code === "not_conflicted") {
				onclose();
				return;
			}

			view = {
				kind: "error",
				path,
				repo,
				message: errorMessage(e, "Could not load this conflict"),
				retryable: !(isTrunkError(e) && UNRESOLVABLE_HERE.has(e.code)),
			};
			loading = false;
		});
}

// ---------- Synchronized scroll ----------
const OUTPUT_PANEL = 2;
let scrolling = false;
let readingSide: MergeSide = "ours";
let scrollRaf = 0;

function handleScroll(sourceIdx: number) {
	if (scrolling) return;
	const source = panelRefs[sourceIdx];
	if (!source) return;
	let sideTop = source.scrollTop;
	if (sourceIdx !== OUTPUT_PANEL)
		readingSide = sourceIdx === 0 ? "ours" : "theirs";
	if (sourceIdx === OUTPUT_PANEL) {
		if (!scrollLayouts) return;
		sideTop = mapOffset(
			scrollLayouts.output,
			scrollLayouts.side,
			source.scrollTop,
		);
	}
	scrolling = true;
	// Sync other panels immediately (no DOM mutation, so no jitter)
	scrollPanels(sideTop, sourceIdx);
	// Defer virtualization state update to next frame so DOM mutations
	// don't happen mid-scroll (which causes jitter on the source panel)
	cancelAnimationFrame(scrollRaf);
	scrollRaf = requestAnimationFrame(() => {
		panelScrollTop = panelRefs[0]?.scrollTop ?? sideTop;
		if (hasConflicts) {
			focusedConflictIdx = conflictNearest(
				headerCentres,
				panelScrollTop + panelViewportHeight / 2,
			);
		}
		scrolling = false;
	});
}

/** Scroll every panel but `except` to show what the sides show at `sideTop`. */
function scrollPanels(sideTop: number, except = -1) {
	panelRefs.forEach((el, i) => {
		if (!el || i === except) return;
		if (i !== OUTPUT_PANEL) el.scrollTop = sideTop;
		else if (scrollLayouts)
			el.scrollTop = mapOffset(
				scrollLayouts.side,
				scrollLayouts.output,
				sideTop,
			);
	});
}

function expandGap(row: FlatRow, side: MergeSide) {
	readingSide = side;
	expandedGaps = new Set([...expandedGaps, row.regionIdx]);
}

// Read the old scroll position before the browser clamps it to the new layout.
let previous:
	| {
			model: typeof aligned;
			file: typeof sources;
			full: boolean;
			columns: number;
			measurement: number;
	  }
	| undefined;
$effect.pre(() => {
	const next = {
		model: aligned,
		file: sources,
		full: fullFile,
		columns: sideColumns,
		measurement: measurementVersion,
	};
	const old = previous;
	previous = next;
	if (!old || old.file !== next.file || !old.model.rows.length) return;

	untrack(() => {
		const side = panelRefs[0];
		if (!side) return;
		const anchor =
			old.full !== next.full ||
			old.columns !== next.columns ||
			old.measurement !== next.measurement
				? conflictIndices[focusedConflictIdx]
				: undefined;
		const top = reflowedSideTop({
			before: old.model,
			after: next.model,
			top: side.scrollTop,
			viewport: panelViewportHeight,
			focusedRegion: anchor,
			readingSide,
		});
		cancelAnimationFrame(scrollRaf);
		holdScrollEvents();
		panelScrollTop = top;
		tick().then(() => {
			if (previous !== next) return;
			side.scrollTop = top;
			scrollPanels(side.scrollTop);
			panelScrollTop = side.scrollTop;
		});
	});
});

// A take grows or shrinks the output above the place on screen, so the output
// is lined up again with what the sides show.
$effect(() => {
	if (!scrollLayouts) return;
	const output = panelRefs[OUTPUT_PANEL];
	const side = panelRefs[0];
	if (!output || !side) return;
	holdScrollEvents();
	output.scrollTop = mapOffset(
		scrollLayouts.side,
		scrollLayouts.output,
		side.scrollTop,
	);
});

/** Ignore the scroll events a programmatic scroll raises until the next frame. */
function holdScrollEvents() {
	scrolling = true;
	requestAnimationFrame(() => {
		scrolling = false;
	});
}

// ---------- Event handlers ----------
function afterDiscardingTypedOutput(action: () => void) {
	if (loading || saving) return;
	if (!manualEdit) {
		action();
		return;
	}

	const version = loadVersion;
	const typed = manualText;
	void ask("Discard the text you typed into the output?", {
		title: "Discard Typed Output",
		kind: "warning",
		okLabel: "Discard",
	}).then((discard) => {
		if (saving || !discard || version !== loadVersion || typed !== manualText)
			return;

		manualEdit = false;
		manualText = "";
		action();
	});
}

function handleTakeAllCurrent() {
	afterDiscardingTypedOutput(() => {
		takenLines = takeAllCurrent(regions);
	});
}

function handleTakeAllIncoming() {
	afterDiscardingTypedOutput(() => {
		takenLines = takeAllIncoming(regions);
	});
}

function handleToggleHunk(side: "ours" | "theirs", regionIdx: number) {
	afterDiscardingTypedOutput(() => {
		takenLines = toggleHunk(side, regionIdx, regions, takenLines);
	});
}

let lastClickedKey = $state<string | null>(null);

function isPointerClick(event: MouseEvent) {
	return event.detail > 0;
}

function handleToggleLine(key: string, event: MouseEvent) {
	const extending = isPointerClick(event) && event.shiftKey;
	afterDiscardingTypedOutput(() => toggleLineFrom(key, extending));
}

function toggleLineFrom(key: string, extending: boolean) {
	if (extending && lastClickedKey) {
		// Parse keys: "side-regionIdx-lineIdx"
		const [side, regStr, lineStr] = key.split("-");
		const [lastSide, lastRegStr, lastLineStr] = lastClickedKey.split("-");
		if (side === lastSide && regStr === lastRegStr) {
			const from = Math.min(+lineStr, +lastLineStr);
			const to = Math.max(+lineStr, +lastLineStr);
			// Determine action: if target line is not taken, select the range; otherwise deselect
			const selecting = !takenLines.has(key);
			const result = new Set(takenLines);
			for (let j = from; j <= to; j++) {
				const k = `${side}-${regStr}-${j}`;
				if (selecting) result.add(k);
				else result.delete(k);
			}
			takenLines = result;
			lastClickedKey = key;
			return;
		}
	}
	takenLines = toggleLine(key, takenLines);
	lastClickedKey = key;
}

function handleOutputEdit(e: Event) {
	if (loading || saving) return;
	manualEdit = true;
	manualText = (e.target as HTMLTextAreaElement).value;
}

function handleReset() {
	afterDiscardingTypedOutput(() => {
		takenLines = new Set();
		lastClickedKey = null;
	});
}

function handlePrevConflict() {
	if (!hasPrev) return;
	focusedConflictIdx--;
	scrollToConflict(focusedConflictIdx);
}

function handleNextConflict() {
	if (!hasNext) return;
	focusedConflictIdx++;
	scrollToConflict(focusedConflictIdx);
}

function scrollToConflict(idx: number) {
	const centre = headerCentres[idx];
	const scrollTo = Math.max(0, (centre ?? 0) - panelViewportHeight / 2);
	cancelAnimationFrame(scrollRaf);
	holdScrollEvents();
	scrollPanels(scrollTo);
	panelScrollTop = panelRefs[0]?.scrollTop ?? scrollTo;
}

async function handleSaveAndResolve() {
	if (!displayed || loading || saving || (!manualEdit && unresolved > 0))
		return;
	const version = loadVersion;
	const { path, repo } = displayed;
	const edited = manualText;
	const expectedRevision = displayed.sides.revision;
	saving = true;
	try {
		if (needsReview) {
			const blocks =
				unresolved === 1 ? "1 conflict had" : `${unresolved} conflicts had`;
			const confirmed = await ask(
				`${blocks} no lines selected before you edited Output. Stage ${flattened(path)} exactly as shown and mark it resolved?`,
				{
					title: "Review Manual Resolution",
					kind: "warning",
					okLabel: "Stage This Output",
				},
			);
			if (
				!confirmed ||
				version !== loadVersion ||
				edited !== manualText ||
				!manualEdit
			)
				return;
		}
		await safeInvoke("save_merge_result", {
			path: repo,
			filePath: path,
			expectedRevision,
			content: manualEdit
				? manualText.replace(/\r?\n/g, lineEndingOf(regions))
				: outputText,
		});
		picks.forget(repo, path);
		if (version === loadVersion) onresolved();
	} catch (e) {
		reportErrorToast(e, "Save failed");
	} finally {
		saving = false;
	}
}

// ---------- Helpers ----------
/** Whether all, some or none of one side's lines in a conflict are taken, in
 *  the values `aria-pressed` takes. */
function sideTaken(
	side: "ours" | "theirs",
	regionIdx: number,
): boolean | "mixed" {
	if (regions[regionIdx]?.type !== "conflict") return false;
	const keys = sideKeys(side, regionIdx, regions);
	const taken = keys.filter((key) => takenLines.has(key)).length;
	if (taken === 0) return false;
	return taken === keys.length ? true : "mixed";
}
registerUpdateBlocker(
	() => "Finish or close the merge editor before restarting.",
);
</script>

<svelte:window onkeydown={handleMergeKeydown} />

{#snippet conflictHeader(side: "ours" | "theirs", row: FlatRow)}
	{@const taken = sideTaken(side, row.regionIdx)}
	<div class="w-full conflict-header shrink-0">
		<Row
			variant="divider"
			reveal="always"
			tone="muted"
			aria-label="Take conflict {row.conflictNum} from {SIDE_LABEL[side]}"
			aria-pressed={taken}
			disabled={saving}
			onclick={() => handleToggleHunk(side, row.regionIdx)}
		>
			{#snippet actions()}
				{#if side === "ours" && sources?.base_oid}
					<Button
						size="sm"
						variant="ghost"
						aria-label="Show merge base for conflict {row.conflictNum}"
						tooltip="Show merge base"
						onclick={(e) => showBase(row, e.currentTarget)}
						>Base</Button
					>
				{/if}
			{/snippet}
			{#if taken === true}
				<Check size={14} class="text-success" />
			{:else if taken === "mixed"}
				<Minus size={14} class="text-success" />
			{:else}
				<span class="icon-slot inline-block"></span>
			{/if}
			Conflict {row.conflictNum}
		</Row>
	</div>
{/snippet}

{#snippet sourceText(line: SideLine, spans: readonly MergedSpan[] | undefined)}
	{@const text = line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text}
	{@const trailing = diffPreferences.showInvisibles
		? trailingWhitespaceStart(text)
		: text.length}
	<span
		class="syntax-highlight pl-1 flex-1 min-w-0 text-diff-text"
		class:whitespace-pre={!sideWrap}
		class:overflow-x-auto={!sideWrap}
		class:whitespace-break-spaces={sideWrap}
		class:self-start={sideWrap}
		use:watchWrap={line.key}
		class:break-all={sideWrap}
		>{#if spans?.length}
			{#each spans as span}
				{@const token = text.slice(span.start, span.end)}
				{#if span.emphasized}
					<mark class="merge-word"
						><MergeText
							text={token}
							showInvisibles={diffPreferences.showInvisibles}
							trailingStart={trailing - span.start}
						/></mark
					>
				{:else}
					<span class={span.syntax_class}
						><MergeText
							text={token}
							showInvisibles={diffPreferences.showInvisibles}
							trailingStart={trailing - span.start}
						/></span
					>
				{/if}
			{/each}
		{:else}
			<MergeText
				{text}
				showInvisibles={diffPreferences.showInvisibles}
				trailingStart={trailing}
			/>
		{/if}</span
	>
{/snippet}

{#snippet conflictLine(
	row: FlatRow,
	line: SideLine,
	spans: readonly MergedSpan[] | undefined,
)}
	{@const taken = takenLines.has(line.key)}
	<div class="merge-line shrink-0" style:height="{row.height}px">
		<Row
			variant="fill"
			aria-pressed={taken}
			aria-label={`${line.lineNum} ${line.text}`}
			disabled={saving}
			onclick={(e: MouseEvent) => handleToggleLine(line.key, e)}
		>
			<span class="flex-1 self-stretch flex min-w-0">
				<span
					class="line-no shrink-0 text-right pr-2 text-text-muted select-none"
					>{line.lineNum}</span
				>
				<span class="w-5 shrink-0 flex justify-center">
					{#if taken}
						<span class="icon-taken"
							><Check size={14} class="text-success" /></span
						>
						<span class="icon-remove"
							><CircleX size={14} class="text-danger" /></span
						>
					{:else}
						<span class="icon-add"
							><Plus size={14} class="text-text-muted" /></span
						>
					{/if}
				</span>
				{@render sourceText(line, spans)}
			</span>
		</Row>
	</div>
{/snippet}

{#snippet sourceHeader(
	side: "ours" | "theirs",
	revision: string | null | undefined,
	take: () => void,
)}
	{@const label = side === "ours" ? "Current" : "Incoming"}
	<div
		class="source-header h-bar bg-surface border-b border-border flex items-center px-2 gap-2 shrink-0"
	>
		<span
			class="source-label flex-1 min-w-0 truncate text-callout text-text"
			title={revision ? `${label} · ${flattened(revision)}` : SIDE_LABEL[side]}
		>
			{label}{#if revision}
				<span class="source-revision text-text-muted"
					><span class="source-separator">{" · "}</span>
					{flattened(revision)}</span
				>
			{/if}
		</span>
		<Button
			size="sm"
			disabled={saving}
			onclick={take}
			aria-label="Take All {label}"
			tooltip="Take All {label}"
		>
			<span class="take-all-text"
				>Take All<span class="take-side-name">{` ${label}`}</span></span
			>
			<span class="take-all-icon"><CheckCheck size={14} /></span>
		</Button>
	</div>
{/snippet}

{#snippet sideRows(side: MergeSide, highlights: MergeSides["ours_spans"])}
	<div aria-hidden="true" class="flex h-0 overflow-hidden">
		<span class="line-no shrink-0"></span
		><span class="w-5 shrink-0 mr-1"></span>
		{#if side === "ours"}
			<span
				class="flex-1 min-w-0"
				bind:this={probe}
				bind:clientWidth={oursWidth}
			></span>
		{:else}
			<span class="flex-1 min-w-0" bind:clientWidth={theirsWidth}></span>
		{/if}
	</div>
	<div class="shrink-0" style:height="{visible.offsetTop}px"></div>
	{#each aligned.rows.slice(visible.start, visible.end) as row (row.regionIdx +
		":" +
		row.slot)}
		{@const line = row[side]}
		{#if row.type === "conflict-header"}
			{@render conflictHeader(side, row)}
		{:else if row.type === "gap"}
			{@const count = row.hiddenBySide[side]}
			{@const label = count
				? `${count} hidden ${count === 1 ? "line" : "lines"}`
				: "hidden context on other side"}
			<div style:height="{row.height}px">
				<Row
					variant="divider"
					tone="muted"
					aria-label="Expand {label}"
					onclick={() => expandGap(row, side)}
				>
					<ChevronDown size={14} />
					{label}
				</Row>
			</div>
		{:else if !line}
			<div class="shrink-0" style:height="{row.height}px"></div>
		{:else if row.type === "conflict-line"}
			{@render conflictLine(row, line, highlights?.[line.lineNum])}
		{:else}
			<div class="flex shrink-0 bg-transparent" style:height="{row.height}px">
				<span
					class="line-no shrink-0 text-right pr-2 text-text-muted select-none"
					>{line.lineNum}</span
				>
				<span class="w-5 shrink-0"></span>
				{@render sourceText(line, highlights?.[line.lineNum])}
			</div>
		{/if}
	{/each}
	<div
		class="shrink-0"
		style:height="{visible.totalHeight - aligned.offsets[visible.end]}px"
	></div>
{/snippet}

<div
	class="h-full flex flex-col bg-bg"
	aria-busy={loading}
	inert={loading && !!view}
>
	{#if !view}
		<!-- Loading state -->
		<div
			class="flex-1 flex items-center justify-center text-text-muted text-body"
		>
			Loading merge editor...
		</div>
	{:else if view.kind === "error"}
		<!-- Error state -->
		<div
			class="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted text-body"
		>
			<span class="text-diff-delete">{view.message}</span>
			{#if view.retryable}
				<Button
					size="sm"
					onclick={() => loadSides({ repo: repoPath, path: filePath })}
					>Retry</Button
				>
			{/if}
		</div>
	{:else if displayed}
		<section
			aria-label="Merge file controls"
			class="h-bar bg-surface shadow-hairline flex items-center gap-1 px-2 shrink-0"
		>
			<span class="flex-1 min-w-0">
				<LinkButton
					truncate
					aria-label={`Path actions for ${displayed.path}`}
					aria-haspopup="menu"
					onclick={openPathMenu}
					oncontextmenu={openPathMenu}
				>
					<FilePathLabel path={displayed.path} />
				</LinkButton>
			</span>
			<Button
				icon
				size="sm"
				variant="ghost"
				aria-label={contextToggleLabel}
				title={contextToggleLabel}
				onclick={() => (fullFile = !fullFile)}
			>
				{#if fullFile}
					<FoldVertical size={14} />
				{:else}
					<UnfoldVertical size={14} />
				{/if}
			</Button>
			<DiffTextControls
				showInvisibles={diffPreferences.showInvisibles}
				wordWrap={diffPreferences.wordWrap}
				fixedPitch={sideWrapAvailable}
				onshowinvisibleschange={(show) =>
					diffPreferences.changeShowInvisibles(show)}
				onwordwrapchange={(wrap) => diffPreferences.changeWordWrap(wrap)}
			/>
		</section>
		<!-- Top row: Current + Incoming side by side (50% height) -->
		<div class="flex-1 flex min-h-0">
			<!-- Current (Ours) Panel -->
			<section
				class="current-side flex-1 flex flex-col min-w-0 border-r border-border"
				aria-label={SIDE_LABEL.ours}
			>
				{@render sourceHeader(
					"ours",
					sources?.current_label,
					handleTakeAllCurrent,
				)}

				<!-- Virtualized scrollable content -->
				<div
					bind:this={panelRefs[0]}
					bind:clientHeight={panelViewportHeight}
					onscroll={() => handleScroll(0)}
					class="flex-1 overflow-y-auto font-mono text-callout"
					style:line-height="{LINE_HEIGHT}px"
				>
					{#key displayed}
						{@render sideRows("ours", sources?.ours_spans)}
					{/key}
				</div>
			</section>

			<!-- Incoming (Theirs) Panel -->
			<section
				class="incoming-side flex-1 flex flex-col min-w-0"
				aria-label={SIDE_LABEL.theirs}
			>
				{@render sourceHeader(
					"theirs",
					sources?.incoming_label,
					handleTakeAllIncoming,
				)}

				<!-- Virtualized scrollable content -->
				<div
					bind:this={panelRefs[1]}
					onscroll={() => handleScroll(1)}
					class="flex-1 overflow-y-auto font-mono text-callout"
					style:line-height="{LINE_HEIGHT}px"
				>
					{#key displayed}
						{@render sideRows("theirs", sources?.theirs_spans)}
					{/key}
				</div>
			</section>
		</div>

		<!-- Bottom panel: Output (50% height) -->
		<div class="flex-1 flex flex-col min-h-0 border-t border-border">
			<div
				class="bg-surface shadow-hairline flex flex-wrap output-bar items-center px-2 gap-x-2 shrink-0"
			>
				<span class="flex flex-1 items-center text-callout text-text-muted"
					>Output</span
				>
				<div class="flex items-center gap-1">
					{#if needsReview}
						<span class="text-caption text-text-muted whitespace-nowrap"
							>{unresolved} {unresolved === 1 ? "block" : "blocks"} to
							review</span
						>
					{:else if unresolved > 0}
						<span class="text-caption text-text-muted whitespace-nowrap"
							>{unresolved}
							{unresolved === 1 ? "conflict" : "conflicts"} unresolved</span
						>
					{:else if manualEdit}
						<span class="text-caption text-text-muted whitespace-nowrap"
							>Manual edit</span
						>
					{/if}
					<Button
						icon
						size="sm"
						variant="ghost"
						disabled={saving}
						onclick={handleReset}
						aria-label="Reset merge selections"
						title="Clear every conflict's selection"
						><RotateCcw size={14} /></Button
					>
					{#if hasConflicts}
						<Button
							icon
							size="sm"
							variant="ghost"
							onclick={handlePrevConflict}
							disabled={!hasPrev}
							aria-label="Previous conflict"
							aria-keyshortcuts="["
							tooltip="Previous conflict ([)"
							><ChevronUp size={16} /></Button
						>
						<span class="text-small text-text-muted whitespace-nowrap"
							>{focusedConflictIdx + 1}/{conflictIndices.length}</span
						>
						<Button
							icon
							size="sm"
							variant="ghost"
							onclick={handleNextConflict}
							disabled={!hasNext}
							aria-label="Next conflict"
							aria-keyshortcuts="]"
							tooltip="Next conflict (])"
							><ChevronDown size={16} /></Button
						>
					{/if}
				</div>

				<!-- Right: actions -->
				<div class="ml-auto flex items-center gap-2 justify-end">
					<Button
						size="sm"
						variant="success"
						onclick={handleSaveAndResolve}
						disabled={saving || (!manualEdit && unresolved > 0)}
						>{needsReview
							? "Review and Save…"
							: "Save and Mark Resolved"}</Button
					>
					<Button
						icon
						size="sm"
						variant="ghost"
						onclick={onclose}
						aria-label="Close merge editor"
						><X size={16} /></Button
					>
				</div>
			</div>

			{#key displayed}
				<MergeOutput
					filePath={displayed.path}
					text={outputText}
					readonly={saving || loading}
					lineHeight={LINE_HEIGHT}
					wordWrap={sideWrap}
					showInvisibles={diffPreferences.showInvisibles}
					bind:element={panelRefs[OUTPUT_PANEL]}
					bind:wrapColumns={outputColumns}
					oninput={handleOutputEdit}
					onscroll={() => handleScroll(OUTPUT_PANEL)}
				/>
			{/key}
		</div>
	{/if}
</div>

{#if baseView}
	<Dialog
		size="md"
		title={baseView.content?.scope === "file"
			? "Merge base · full file"
			: `Merge base · conflict ${baseView.number}`}
		oncancel={closeBase}
	>
		<div class="flex flex-col min-w-0 gap-2">
			<div class="flex items-center text-callout text-text-muted"
				><FilePathLabel path={filePath} /></div
			>
			{#if baseView.error}
				<p role="alert" class="text-callout text-text-muted"
					>{baseView.error}</p
				>
			{:else if baseView.content}
				{#if baseView.content.text}
					<textarea
						readonly
						wrap={diffPreferences.wordWrap ? "soft" : "off"}
						class="merge-base-code w-full resize-none bg-bg p-2 text-callout leading-code font-mono text-text"
						rows={Math.min(
							24,
							Math.max(2, baseView.content.text.split("\n", 24).length),
						)}
						aria-label="Merge base text"
						value={baseView.content.text}
					></textarea>
				{:else}
					<p class="text-callout text-text-muted"
						>{baseView.content.scope === "file"
							? "Empty file"
							: "No lines in the base"}</p
					>
				{/if}
			{:else}
				<p role="status" class="text-callout text-text-muted"
					>Reading merge base…</p
				>
			{/if}
			<div class="flex justify-end"
				><Button size="sm" onclick={closeBase}>Close</Button></div
			>
		</div>
	</Dialog>
{/if}

<style>
.merge-base-code {
	max-height: 60vh;
}
.current-side,
.incoming-side {
	container-type: inline-size;
}
@container (max-width: 13rem) {
	.take-side-name {
		display: none;
	}
}
.take-all-icon {
	display: none;
}
@container (max-width: 10rem) {
	.source-header {
		height: auto;
		min-height: var(--bar-h);
		padding-block: var(--space-1);
		gap: var(--space-1);
	}
	.source-revision {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.source-separator,
	.take-all-text {
		display: none;
	}
	.take-all-icon {
		display: inline-flex;
	}
}
/* A plus previews taking a line. The check belongs to a line already taken. */
.merge-line .icon-add {
	display: none;
}
.merge-line:hover .icon-add {
	display: inline-flex;
}

/* Taken lines: show green check by default, swap to red X on row hover */
.merge-line .icon-remove {
	display: none;
}
.merge-line:hover .icon-taken {
	display: none;
}
.merge-line:hover .icon-remove {
	display: inline-flex;
}

/* One bar tall plus the rule it paints along its top, so the conflict's lines start below both */
.conflict-header {
	height: calc(var(--bar-h) + 1px);
}

.icon-slot {
	width: calc(7 * var(--u) / 2);
	height: calc(7 * var(--u) / 2);
}

.line-no {
	width: calc(12 * var(--u));
}

.current-side {
	--merge-source: var(--color-accent);
	--merge-line-bg: var(--color-merge-current-line);
	--merge-word-bg: var(--color-merge-current-word);
}

.incoming-side {
	--merge-source: var(--color-accent-alt);
	--merge-line-bg: var(--color-merge-incoming-line);
	--merge-word-bg: var(--color-merge-incoming-word);
}

.source-label {
	border-inline-start: 2px solid var(--merge-source);
	padding-inline-start: var(--space-1);
}

.merge-line {
	background: var(--merge-line-bg);
	box-shadow: inset 4px 0 var(--merge-source);
}

.merge-word {
	--color-invisible: var(--color-diff-text);
	--color-trailing-ws-fg: var(--color-diff-text);
	--color-trailing-ws-bg: transparent;
	color: var(--color-diff-text);
	background: var(--merge-word-bg);
}

.output-bar > * {
	min-height: var(--bar-h);
}
</style>
