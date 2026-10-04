<script lang="ts">
import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import CircleX from "@lucide/svelte/icons/circle-x";
import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
import X from "@lucide/svelte/icons/x";
import { tick } from "svelte";
import { BAR_HEIGHT } from "../lib/chrome-heights.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	type ConflictRegion,
	computeOutput,
	getConflictIndices,
	parseConflictRegions,
	takeAllCurrent,
	takeAllIncoming,
	toggleHunk,
	toggleLine,
} from "../lib/merge-parser.js";
import type { MergeSides } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";

interface Props {
	repoPath: string;
	filePath: string;
	onclose: () => void;
	onresolved: () => void;
}

let { repoPath, filePath, onclose, onresolved }: Props = $props();

// ---------- Constants ----------
const LINE_HEIGHT = 18;

/* A conflict header fences content on both sides, so it draws a rule on each
   edge. Both rules paint inside the box, so it needs one pixel more than a
   plain bar to leave the same visible band between them. */
const CONFLICT_HEADER_HEIGHT = BAR_HEIGHT + 1;
const OVERSCAN = 20;

// ---------- State ----------
let regions = $state<ConflictRegion[]>([]);
let takenLines = $state<Set<string>>(new Set());
let manualEdit = $state(false);
let manualText = $state("");
let loading = $state(true);
let error = $state<string | null>(null);
let focusedConflictIdx = $state(0);
let saving = $state(false);

let panelRefs: HTMLElement[] = [];
let panelScrollTop = $state(0);
let panelViewportHeight = $state(400);

// ---------- Flat row types for virtualization ----------
interface FlatRow {
	type: "context" | "conflict-header" | "conflict-line" | "padding";
	regionIdx: number;
	lineIdx: number;
	text: string;
	key: string;
	lineNum: number;
	conflictNum: number;
	height: number;
}

/** Flatten both panels together so conflict regions are padded to equal height (aligned headers). */
function flattenAligned(regions: ConflictRegion[]): {
	ours: FlatRow[];
	theirs: FlatRow[];
} {
	const ours: FlatRow[] = [];
	const theirs: FlatRow[] = [];
	let oursLineNum = 1,
		theirsLineNum = 1;
	let conflictCount = 0;

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i];
		if (region.type === "context") {
			for (let j = 0; j < region.oursLines.length; j++) {
				ours.push({
					type: "context",
					regionIdx: i,
					lineIdx: j,
					text: region.oursLines[j],
					key: "",
					lineNum: oursLineNum + j,
					conflictNum: 0,
					height: LINE_HEIGHT,
				});
			}
			for (let j = 0; j < region.theirsLines.length; j++) {
				theirs.push({
					type: "context",
					regionIdx: i,
					lineIdx: j,
					text: region.theirsLines[j],
					key: "",
					lineNum: theirsLineNum + j,
					conflictNum: 0,
					height: LINE_HEIGHT,
				});
			}
			oursLineNum += region.oursLines.length;
			theirsLineNum += region.theirsLines.length;
		} else {
			conflictCount++;
			// Headers
			ours.push({
				type: "conflict-header",
				regionIdx: i,
				lineIdx: -1,
				text: "",
				key: "",
				lineNum: 0,
				conflictNum: conflictCount,
				height: CONFLICT_HEADER_HEIGHT,
			});
			theirs.push({
				type: "conflict-header",
				regionIdx: i,
				lineIdx: -1,
				text: "",
				key: "",
				lineNum: 0,
				conflictNum: conflictCount,
				height: CONFLICT_HEADER_HEIGHT,
			});
			// Conflict lines
			for (let j = 0; j < region.oursLines.length; j++) {
				ours.push({
					type: "conflict-line",
					regionIdx: i,
					lineIdx: j,
					text: region.oursLines[j],
					key: `ours-${i}-${j}`,
					lineNum: oursLineNum + j,
					conflictNum: 0,
					height: LINE_HEIGHT,
				});
			}
			for (let j = 0; j < region.theirsLines.length; j++) {
				theirs.push({
					type: "conflict-line",
					regionIdx: i,
					lineIdx: j,
					text: region.theirsLines[j],
					key: `theirs-${i}-${j}`,
					lineNum: theirsLineNum + j,
					conflictNum: 0,
					height: LINE_HEIGHT,
				});
			}
			// Pad the shorter side so next region starts at the same offset
			const diff = region.oursLines.length - region.theirsLines.length;
			if (diff > 0) {
				theirs.push({
					type: "padding",
					regionIdx: i,
					lineIdx: -2,
					text: "",
					key: "",
					lineNum: 0,
					conflictNum: 0,
					height: diff * LINE_HEIGHT,
				});
			} else if (diff < 0) {
				ours.push({
					type: "padding",
					regionIdx: i,
					lineIdx: -2,
					text: "",
					key: "",
					lineNum: 0,
					conflictNum: 0,
					height: -diff * LINE_HEIGHT,
				});
			}
			oursLineNum += region.oursLines.length;
			theirsLineNum += region.theirsLines.length;
		}
	}
	return { ours, theirs };
}

function computeOffsets(rows: FlatRow[]): number[] {
	const offsets = new Array(rows.length + 1);
	offsets[0] = 0;
	for (let i = 0; i < rows.length; i++) {
		offsets[i + 1] = offsets[i] + rows[i].height;
	}
	return offsets;
}

function getVisibleRange(
	scrollTop: number,
	viewportHeight: number,
	offsets: number[],
): [number, number] {
	const totalRows = offsets.length - 1;
	if (totalRows === 0) return [0, 0];
	// Binary search for first visible row
	let lo = 0,
		hi = totalRows;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid + 1] <= scrollTop) lo = mid + 1;
		else hi = mid;
	}
	const start = Math.max(0, lo - OVERSCAN);
	// Find last visible row
	const bottom = scrollTop + viewportHeight;
	lo = start;
	hi = totalRows;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offsets[mid] < bottom) lo = mid + 1;
		else hi = mid;
	}
	const end = Math.min(totalRows, lo + OVERSCAN);
	return [start, end];
}

// ---------- Derived ----------
let conflictIndices = $derived(getConflictIndices(regions));
let outputText = $derived.by(() => {
	if (manualEdit) return manualText;
	return computeOutput(regions, takenLines);
});
let hasPrev = $derived(focusedConflictIdx > 0);
let hasNext = $derived(focusedConflictIdx < conflictIndices.length - 1);
let hasConflicts = $derived(conflictIndices.length > 0);

// Virtualization derived state
let aligned = $derived(flattenAligned(regions));
let oursFlat = $derived(aligned.ours);
let theirsFlat = $derived(aligned.theirs);
let oursOffsets = $derived(computeOffsets(oursFlat));
let theirsOffsets = $derived(computeOffsets(theirsFlat));
let oursTotalHeight = $derived(oursOffsets[oursFlat.length] ?? 0);
let theirsTotalHeight = $derived(theirsOffsets[theirsFlat.length] ?? 0);
let oursVisible = $derived(
	getVisibleRange(panelScrollTop, panelViewportHeight, oursOffsets),
);
let theirsVisible = $derived(
	getVisibleRange(panelScrollTop, panelViewportHeight, theirsOffsets),
);

// ---------- Data loading ----------
$effect(() => {
	// Re-run when filePath changes
	const currentPath = filePath;
	loading = true;
	error = null;

	safeInvoke<MergeSides>("get_merge_sides", {
		path: repoPath,
		filePath: currentPath,
	})
		.then((result) => {
			regions = parseConflictRegions(result.base, result.ours, result.theirs);
			takenLines = takeAllCurrent(regions);
			manualEdit = false;
			manualText = "";
			focusedConflictIdx = 0;
			panelScrollTop = 0;
			loading = false;
			tick().then(() => scrollToConflict(0));
		})
		.catch(() => {
			// Merge state no longer available (e.g. git reset) — close the editor
			onclose();
		});
});

// ---------- Synchronized scroll ----------
let scrolling = false;
let scrollRaf = 0;

function handleScroll(sourceIdx: number) {
	if (scrolling) return;
	scrolling = true;
	const source = panelRefs[sourceIdx];
	if (!source) {
		scrolling = false;
		return;
	}
	const st = source.scrollTop;
	// Sync other panels immediately (no DOM mutation, so no jitter)
	panelRefs.forEach((el, i) => {
		if (el && i !== sourceIdx) el.scrollTop = st;
	});
	// Defer virtualization state update to next frame so DOM mutations
	// don't happen mid-scroll (which causes jitter on the source panel)
	cancelAnimationFrame(scrollRaf);
	scrollRaf = requestAnimationFrame(() => {
		panelScrollTop = st;
		scrolling = false;
	});
}

// ---------- Event handlers ----------
function handleTakeAllCurrent() {
	takenLines = takeAllCurrent(regions);
}

function handleTakeAllIncoming() {
	takenLines = takeAllIncoming(regions);
}

function handleToggleHunk(side: "ours" | "theirs", regionIdx: number) {
	takenLines = toggleHunk(side, regionIdx, regions, takenLines);
}

let lastClickedKey = $state<string | null>(null);

function isPointerClick(event: MouseEvent) {
	return event.detail > 0;
}

function handleToggleLine(key: string, event: MouseEvent) {
	if (isPointerClick(event) && event.shiftKey && lastClickedKey) {
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
	manualEdit = true;
	manualText = (e.target as HTMLTextAreaElement).value;
}

function handleReset() {
	takenLines = takeAllCurrent(regions);
	manualEdit = false;
	manualText = "";
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
	const regionIndex = conflictIndices[idx];
	if (regionIndex == null) return;
	// Find the conflict header row in the flat array
	const rowIdx = oursFlat.findIndex(
		(r) => r.type === "conflict-header" && r.regionIdx === regionIndex,
	);
	if (rowIdx === -1) return;
	const targetTop = oursOffsets[rowIdx];
	const scrollTo = Math.max(
		0,
		targetTop - panelViewportHeight / 2 + CONFLICT_HEADER_HEIGHT / 2,
	);
	scrolling = true;
	for (const panel of panelRefs) {
		if (panel) panel.scrollTop = scrollTo;
	}
	panelScrollTop = scrollTo;
	requestAnimationFrame(() => {
		scrolling = false;
	});
}

async function handleSaveAndResolve() {
	saving = true;
	try {
		await safeInvoke("save_merge_result", {
			path: repoPath,
			filePath,
			content: outputText,
		});
		// File resolved — staging panel updates automatically
		onresolved();
	} catch (e) {
		reportErrorToast(e, "Save failed");
	} finally {
		saving = false;
	}
}

// ---------- Helpers ----------
/** Check if all lines from one side of a conflict region are taken */
function isHunkAllTaken(side: "ours" | "theirs", regionIdx: number): boolean {
	const region = regions[regionIdx];
	if (region?.type !== "conflict") return false;
	const lines = side === "ours" ? region.oursLines : region.theirsLines;
	if (lines.length === 0) return false;
	return lines.every((_, j) => takenLines.has(`${side}-${regionIdx}-${j}`));
}
</script>

{#snippet conflictHeader(side: 'ours' | 'theirs', row: FlatRow)}
	<div class="w-full conflict-header shrink-0 bg-surface text-small">
		<Row
			variant="fill"
			tone="muted"
			onclick={() => handleToggleHunk(side, row.regionIdx)}
		>
			<span class="flex-1 flex items-center px-2 gap-1">
				{#if isHunkAllTaken(side, row.regionIdx)}
					<Check size={14} class="text-success" />
				{:else}
					<span class="icon-slot inline-block"></span>
				{/if}
				Conflict {row.conflictNum}
			</span>
		</Row>
	</div>
{/snippet}

{#snippet conflictLine(row: FlatRow, bgColor: string)}
	{@const taken = takenLines.has(row.key)}
	<div
		class="merge-line shrink-0"
		style:height="{LINE_HEIGHT}px"
		style:background={bgColor}
	>
		<Row
			variant="fill"
			onclick={(e: MouseEvent) => handleToggleLine(row.key, e)}
		>
			<span class="flex-1 self-stretch flex min-w-0">
				<span
					class="line-no shrink-0 text-right pr-2 text-text-muted select-none"
					>{row.lineNum}</span
				>
				<span class="w-5 shrink-0 flex items-center justify-center">
					{#if taken}
						<span class="icon-taken"
							><Check size={14} class="text-success" /></span
						>
						<span class="icon-remove"
							><CircleX size={14} class="text-danger" /></span
						>
					{:else}
						<span class="icon-add"
							><Check size={14} class="text-success" /></span
						>
					{/if}
				</span>
				<span
					class="pl-1 whitespace-pre overflow-x-auto flex-1 min-w-0 text-text"
					>{row.text}</span
				>
			</span>
		</Row>
	</div>
{/snippet}

{#snippet contextLine(row: FlatRow)}
	<div class="flex shrink-0 bg-transparent" style:height="{LINE_HEIGHT}px">
		<span class="line-no shrink-0 text-right pr-2 text-text-muted select-none"
			>{row.lineNum}</span
		>
		<span class="w-5 shrink-0"></span>
		<span class="pl-1 whitespace-pre overflow-x-auto flex-1 min-w-0 text-text"
			>{row.text}</span
		>
	</div>
{/snippet}

<div class="h-full flex flex-col bg-bg">
	{#if loading}
		<!-- Loading state -->
		<div
			class="flex-1 flex items-center justify-center text-text-muted text-body"
		>
			Loading merge editor...
		</div>
	{:else if error}
		<!-- Error state -->
		<div
			class="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted text-body"
		>
			<span class="text-diff-delete">{error}</span>
			<Button
				size="sm"
				onclick={() => { loading = true; error = null; safeInvoke<MergeSides>('get_merge_sides', { path: repoPath, filePath }).then((result) => { regions = parseConflictRegions(result.base, result.ours, result.theirs); takenLines = new Set(); manualEdit = false; manualText = ''; focusedConflictIdx = 0; loading = false; }).catch((e) => { error = errorMessage(e, 'Failed to load'); loading = false; }); }}
				>Retry</Button
			>
		</div>
	{:else}
		<!-- Top row: Current + Incoming side by side (50% height) -->
		<div class="flex-1 flex min-h-0">
			<!-- Current (Ours) Panel -->
			<div class="flex-1 flex flex-col min-w-0 border-r border-border">
				<!-- Header -->
				<div
					class="h-bar bg-accent-bg hairline-accent flex items-center py-0 px-2 gap-2 shrink-0"
				>
					<span class="text-callout text-text">Current (Ours)</span>
					<span class="flex-1"></span>
					<Button size="sm" variant="success" onclick={handleTakeAllCurrent}
						>Take All Current</Button
					>
				</div>

				<!-- Virtualized scrollable content -->
				<div
					bind:this={panelRefs[0]}
					bind:clientHeight={panelViewportHeight}
					onscroll={() => handleScroll(0)}
					class="flex-1 overflow-y-auto font-mono text-callout"
					style:line-height="{LINE_HEIGHT}px"
				>
					<div
						class="shrink-0"
						style:height="{oursOffsets[oursVisible[0]]}px"
					></div>
					{#each oursFlat.slice(oursVisible[0], oursVisible[1]) as row, idx (oursVisible[0] + idx)}
						{#if row.type === 'padding'}
							<div class="shrink-0" style:height="{row.height}px"></div>
						{:else if row.type === 'conflict-header'}
							{@render conflictHeader('ours', row)}
						{:else if row.type === 'conflict-line'}
							{@render conflictLine(row, 'var(--color-diff-add-bg)')}
						{:else}
							{@render contextLine(row)}
						{/if}
					{/each}
					<div
						class="shrink-0"
						style:height="{oursTotalHeight - (oursOffsets[oursVisible[1]] ?? oursTotalHeight)}px"
					></div>
				</div>
			</div>

			<!-- Incoming (Theirs) Panel -->
			<div class="flex-1 flex flex-col min-w-0">
				<!-- Header -->
				<div
					class="h-bar bg-success-bg hairline-success flex items-center py-0 px-2 gap-2 shrink-0"
				>
					<span class="text-callout text-text">Incoming (Theirs)</span>
					<span class="flex-1"></span>
					<Button size="sm" variant="success" onclick={handleTakeAllIncoming}
						>Take All Incoming</Button
					>
				</div>

				<!-- Virtualized scrollable content -->
				<div
					bind:this={panelRefs[1]}
					onscroll={() => handleScroll(1)}
					class="flex-1 overflow-y-auto font-mono text-callout"
					style:line-height="{LINE_HEIGHT}px"
				>
					<div
						class="shrink-0"
						style:height="{theirsOffsets[theirsVisible[0]]}px"
					></div>
					{#each theirsFlat.slice(theirsVisible[0], theirsVisible[1]) as row, idx (theirsVisible[0] + idx)}
						{#if row.type === 'padding'}
							<div class="shrink-0" style:height="{row.height}px"></div>
						{:else if row.type === 'conflict-header'}
							{@render conflictHeader('theirs', row)}
						{:else if row.type === 'conflict-line'}
							{@render conflictLine(row, 'var(--color-diff-delete-bg)')}
						{:else}
							{@render contextLine(row)}
						{/if}
					{/each}
					<div
						class="shrink-0"
						style:height="{theirsTotalHeight - (theirsOffsets[theirsVisible[1]] ?? theirsTotalHeight)}px"
					></div>
				</div>
			</div>
		</div>

		<!-- Bottom panel: Output (50% height) -->
		<div class="flex-1 flex flex-col min-h-0 border-t border-border">
			<!-- Header: 3-column grid so the nav naturally centers -->
			<div
				class="h-bar bg-muted-bg hairline-muted grid output-bar items-center py-0 px-2 shrink-0"
			>
				<!-- Left: label -->
				<div class="flex items-center gap-2">
					<span class="text-callout text-text">Output</span>
					{#if manualEdit}
						<span class="text-caption text-text-muted">(manual edit)</span>
					{/if}
					<Button
						icon
						size="sm"
						variant="ghost"
						onclick={handleReset}
						aria-label="Reset merge selections"
						title="Reset to Current (Ours)"
						><RotateCcw size={14} /></Button
					>
				</div>

				<!-- Center: conflict navigation -->
				<div class="flex items-center gap-1">
					{#if hasConflicts}
						<Button
							icon
							size="sm"
							variant="ghost"
							onclick={handlePrevConflict}
							disabled={!hasPrev}
							aria-label="Previous conflict"
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
							><ChevronDown size={16} /></Button
						>
					{/if}
				</div>

				<!-- Right: actions -->
				<div class="flex items-center gap-2 justify-end">
					<Button
						size="sm"
						variant="success"
						onclick={handleSaveAndResolve}
						disabled={saving}
						>Save and Mark Resolved</Button
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

			<!-- Editable output textarea -->
			<textarea
				bind:this={panelRefs[2]}
				value={outputText}
				oninput={handleOutputEdit}
				onscroll={() => handleScroll(2)}
				class="flex-1 w-full resize-none border-none bg-bg text-text font-mono text-callout py-1 px-2 outline-none box-border"
				style:line-height="{LINE_HEIGHT}px"
			></textarea>
		</div>
	{/if}
</div>

<style>
/* Untaken lines: no icon by default, show green check on row hover */
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
	box-shadow:
		inset 0 1px 0 var(--color-border),
		inset 0 -1px 0 var(--color-border);
}

.icon-slot {
	width: 14px;
	height: 14px;
}

.line-no {
	width: calc(12 * var(--u));
}

.hairline-accent {
	box-shadow: inset 0 -1px 0 var(--color-accent);
}

.hairline-success {
	box-shadow: inset 0 -1px 0 var(--color-success);
}

.hairline-muted {
	box-shadow: inset 0 -1px 0 var(--color-text-muted);
}

.output-bar {
	grid-template-columns: 1fr auto 1fr;
}
</style>
