<script lang="ts">
import {
	Check,
	ChevronDown,
	ChevronUp,
	CircleCheck,
	CircleX,
	RotateCcw,
	X,
} from "@lucide/svelte";
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

interface Props {
	repoPath: string;
	filePath: string;
	onclose: () => void;
	onresolved: () => void;
}

let { repoPath, filePath, onclose, onresolved }: Props = $props();

// ---------- Constants ----------
const LINE_HEIGHT = 18;

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
				height: BAR_HEIGHT,
			});
			theirs.push({
				type: "conflict-header",
				regionIdx: i,
				lineIdx: -1,
				text: "",
				key: "",
				lineNum: 0,
				conflictNum: conflictCount,
				height: BAR_HEIGHT,
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

function handleToggleLine(key: string, event?: MouseEvent) {
	if (event?.shiftKey && lastClickedKey) {
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
		targetTop - panelViewportHeight / 2 + BAR_HEIGHT / 2,
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
  <div
    role="button"
    tabindex="0"
    onclick={() => handleToggleHunk(side, row.regionIdx)}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleHunk(side, row.regionIdx); } }}
    style="
      width: 100%;
      height: {BAR_HEIGHT}px;
      background: var(--color-surface);
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      padding: 0 var(--space-2);
      gap: var(--space-1);
      cursor: pointer;
      font-size: 11px;
      color: var(--color-text-muted);
    "
  >
    {#if isHunkAllTaken(side, row.regionIdx)}
      <Check size={14} style="color: var(--color-success);" />
    {:else}
      <span style="width: 14px; height: 14px; display: inline-block;"></span>
    {/if}
    Conflict {row.conflictNum}
  </div>
{/snippet}

{#snippet conflictLine(row: FlatRow, bgColor: string)}
  {@const taken = takenLines.has(row.key)}
  <div
    role="button"
    tabindex="0"
    onclick={(e: MouseEvent) => handleToggleLine(row.key, e)}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleLine(row.key); } }}
    class="merge-line"
    style="
      display: flex;
      height: {LINE_HEIGHT}px;
      background: {bgColor};
      cursor: pointer;
    "
  >
    <span style="
      width: 48px;
      flex-shrink: 0;
      text-align: right;
      padding-right: 8px;
      color: var(--color-text-muted);
      -webkit-user-select: none;
      user-select: none;
    ">{row.lineNum}</span>
    <span style="
      width: 20px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    ">
      {#if taken}
        <span class="icon-taken"><Check size={14} style="color: var(--color-success);" /></span>
        <span class="icon-remove"><CircleX size={14} style="color: var(--color-danger);" /></span>
      {:else}
        <span class="icon-add"><Check size={14} style="color: var(--color-success);" /></span>
      {/if}
    </span>
    <span style="
      padding-left: 4px;
      white-space: pre;
      overflow-x: auto;
      flex: 1;
      min-width: 0;
      color: var(--color-text);
    ">{row.text}</span>
  </div>
{/snippet}

{#snippet contextLine(row: FlatRow)}
  <div style="
    display: flex;
    height: {LINE_HEIGHT}px;
    background: transparent;
  ">
    <span style="
      width: 48px;
      flex-shrink: 0;
      text-align: right;
      padding-right: 8px;
      color: var(--color-text-muted);
      -webkit-user-select: none;
      user-select: none;
    ">{row.lineNum}</span>
    <span style="width: 20px; flex-shrink: 0;"></span>
    <span style="
      padding-left: 4px;
      white-space: pre;
      overflow-x: auto;
      flex: 1;
      min-width: 0;
      color: var(--color-text);
    ">{row.text}</span>
  </div>
{/snippet}

<div style="
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
">
  {#if loading}
    <!-- Loading state -->
    <div style="
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--color-text-muted);
      font-size: 13px;
    ">
      Loading merge editor...
    </div>
  {:else if error}
    <!-- Error state -->
    <div style="
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      color: var(--color-text-muted);
      font-size: 13px;
    ">
      <span style="color: var(--color-diff-delete);">{error}</span>
      <button
        onclick={() => { loading = true; error = null; safeInvoke<MergeSides>('get_merge_sides', { path: repoPath, filePath }).then((result) => { regions = parseConflictRegions(result.base, result.ours, result.theirs); takenLines = new Set(); manualEdit = false; manualText = ''; focusedConflictIdx = 0; loading = false; }).catch((e) => { error = errorMessage(e, 'Failed to load'); loading = false; }); }}
        style="
          background: var(--color-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius);
          color: var(--color-text);
          font-size: 12px;
          padding: var(--space-1) var(--space-3);
          cursor: pointer;
        "
      >Retry</button>
    </div>
  {:else}
    <!-- Top row: Current + Incoming side by side (50% height) -->
    <div style="flex: 1; display: flex; min-height: 0;">

      <!-- Current (Ours) Panel -->
      <div style="flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--color-border);">
        <!-- Header -->
        <div style="
          height: var(--bar-h);
          background: var(--color-accent-bg);
          box-shadow: inset 0 -1px 0 var(--accent);
          display: flex;
          align-items: center;
          padding: 0 var(--space-2);
          gap: var(--space-2);
          flex-shrink: 0;
        ">
          <span style="font-size: 12px; color: var(--color-text);">Current (Ours)</span>
          <span style="flex: 1;"></span>
          <button
            onclick={handleTakeAllCurrent}
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              background: var(--color-success-bg);
              border: 1px solid var(--color-success-border);
              border-radius: var(--radius);
              color: var(--color-success);
              font-size: 11px;
              font-family: var(--font-sans, sans-serif);
              height: var(--control-sm-h);
              padding: 0 var(--space-2);
              cursor: pointer;
              white-space: nowrap;
              flex-shrink: 0;
            "
          >Take All Current</button>
        </div>

        <!-- Virtualized scrollable content -->
        <div
          bind:this={panelRefs[0]}
          bind:clientHeight={panelViewportHeight}
          onscroll={() => handleScroll(0)}
          style="
            flex: 1;
            overflow-y: auto;
            font-family: var(--font-mono);
            font-size: 12px;
            line-height: {LINE_HEIGHT}px;
          "
        >
          <div style="height: {oursOffsets[oursVisible[0]]}px;"></div>
          {#each oursFlat.slice(oursVisible[0], oursVisible[1]) as row, idx (oursVisible[0] + idx)}
            {#if row.type === 'padding'}
              <div style="height: {row.height}px;"></div>
            {:else if row.type === 'conflict-header'}
              {@render conflictHeader('ours', row)}
            {:else if row.type === 'conflict-line'}
              {@render conflictLine(row, 'var(--color-diff-add-bg)')}
            {:else}
              {@render contextLine(row)}
            {/if}
          {/each}
          <div style="height: {oursTotalHeight - (oursOffsets[oursVisible[1]] ?? oursTotalHeight)}px;"></div>
        </div>
      </div>

      <!-- Incoming (Theirs) Panel -->
      <div style="flex: 1; display: flex; flex-direction: column; min-width: 0;">
        <!-- Header -->
        <div style="
          height: var(--bar-h);
          background: var(--color-success-bg);
          box-shadow: inset 0 -1px 0 var(--color-success);
          display: flex;
          align-items: center;
          padding: 0 var(--space-2);
          gap: var(--space-2);
          flex-shrink: 0;
        ">
          <span style="font-size: 12px; color: var(--color-text);">Incoming (Theirs)</span>
          <span style="flex: 1;"></span>
          <button
            onclick={handleTakeAllIncoming}
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              background: var(--color-success-bg);
              border: 1px solid var(--color-success-border);
              border-radius: var(--radius);
              color: var(--color-success);
              font-size: 11px;
              font-family: var(--font-sans, sans-serif);
              height: var(--control-sm-h);
              padding: 0 var(--space-2);
              cursor: pointer;
              white-space: nowrap;
              flex-shrink: 0;
            "
          >Take All Incoming</button>
        </div>

        <!-- Virtualized scrollable content -->
        <div
          bind:this={panelRefs[1]}
          onscroll={() => handleScroll(1)}
          style="
            flex: 1;
            overflow-y: auto;
            font-family: var(--font-mono);
            font-size: 12px;
            line-height: {LINE_HEIGHT}px;
          "
        >
          <div style="height: {theirsOffsets[theirsVisible[0]]}px;"></div>
          {#each theirsFlat.slice(theirsVisible[0], theirsVisible[1]) as row, idx (theirsVisible[0] + idx)}
            {#if row.type === 'padding'}
              <div style="height: {row.height}px;"></div>
            {:else if row.type === 'conflict-header'}
              {@render conflictHeader('theirs', row)}
            {:else if row.type === 'conflict-line'}
              {@render conflictLine(row, 'var(--color-diff-delete-bg)')}
            {:else}
              {@render contextLine(row)}
            {/if}
          {/each}
          <div style="height: {theirsTotalHeight - (theirsOffsets[theirsVisible[1]] ?? theirsTotalHeight)}px;"></div>
        </div>
      </div>
    </div>

    <!-- Bottom panel: Output (50% height) -->
    <div style="flex: 1; display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--color-border);">
      <!-- Header: 3-column grid so the nav naturally centers -->
      <div style="
        height: var(--bar-h);
        background: var(--color-muted-bg);
        box-shadow: inset 0 -1px 0 var(--color-text-muted);
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        padding: 0 var(--space-2);
        flex-shrink: 0;
      ">
        <!-- Left: label -->
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span style="font-size: 12px; color: var(--color-text);">Output</span>
          {#if manualEdit}
            <span style="font-size: 10px; color: var(--color-text-muted);">(manual edit)</span>
          {/if}
          <button
            onclick={handleReset}
            aria-label="Reset merge selections"
            title="Reset to Current (Ours)"
            style="
              background: none;
              border: none;
              cursor: pointer;
              color: var(--color-text-muted);
              padding: var(--space-1);
              display: flex;
              align-items: center;
            "
          ><RotateCcw size={14} /></button>
        </div>

        <!-- Center: conflict navigation -->
        <div style="display: flex; align-items: center; gap: var(--space-1);">
          {#if hasConflicts}
            <button
              onclick={handlePrevConflict}
              disabled={!hasPrev}
              aria-label="Previous conflict"
              style="
                background: none;
                border: none;
                cursor: {hasPrev ? 'pointer' : 'default'};
                color: {hasPrev ? 'var(--color-text)' : 'var(--color-text-muted)'};
                opacity: {hasPrev ? 1 : 0.4};
                padding: var(--space-1);
                display: flex;
                align-items: center;
              "
            ><ChevronUp size={16} /></button>
            <span style="font-size: 11px; color: var(--color-text-muted); white-space: nowrap;">{focusedConflictIdx + 1}/{conflictIndices.length}</span>
            <button
              onclick={handleNextConflict}
              disabled={!hasNext}
              aria-label="Next conflict"
              style="
                background: none;
                border: none;
                cursor: {hasNext ? 'pointer' : 'default'};
                color: {hasNext ? 'var(--color-text)' : 'var(--color-text-muted)'};
                opacity: {hasNext ? 1 : 0.4};
                padding: var(--space-1);
                display: flex;
                align-items: center;
              "
            ><ChevronDown size={16} /></button>
          {/if}
        </div>

        <!-- Right: actions -->
        <div style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
          <button
            onclick={handleSaveAndResolve}
            disabled={saving}
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              background: var(--color-success-bg);
              border: 1px solid var(--color-success-border);
              border-radius: var(--radius);
              color: var(--color-success);
              font-size: 11px;
              font-family: var(--font-sans, sans-serif);
              height: var(--control-sm-h);
              padding: 0 var(--space-2);
              cursor: {saving ? 'not-allowed' : 'pointer'};
              opacity: {saving ? 0.4 : 1};
              white-space: nowrap;
            "
          >Save and Mark Resolved</button>
          <button
            onclick={onclose}
            aria-label="Close merge editor"
            style="
              background: none;
              border: none;
              cursor: pointer;
              color: var(--color-text-muted);
              padding: var(--space-1);
              display: flex;
              align-items: center;
            "
          ><X size={16} /></button>
        </div>
      </div>

      <!-- Editable output textarea -->
      <textarea
        bind:this={panelRefs[2]}
        value={outputText}
        oninput={handleOutputEdit}
        onscroll={() => handleScroll(2)}
        style="
          flex: 1;
          width: 100%;
          resize: none;
          border: none;
          background: var(--color-bg);
          color: var(--color-text);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: {LINE_HEIGHT}px;
          padding: var(--space-1) var(--space-2);
          outline: none;
          box-sizing: border-box;
        "
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
</style>
