<script lang="ts">
import { untrack } from "svelte";
import {
	buildTree,
	collectFilePaths,
	type DirectoryNode,
} from "../lib/build-tree.js";
import { ROW_HEIGHT } from "../lib/chrome-heights.js";
import type { FlatRow } from "../lib/flatten-tree.js";
import {
	collectDirPaths,
	findFocusIndex,
	flattenTree,
	migrateExpanded,
} from "../lib/flatten-tree.js";
import type { FileStatus, ReviewTally } from "../lib/types.js";
import { buildOffsets, windowFor } from "../lib/virtual-window.js";
import DirectoryRow from "./DirectoryRow.svelte";
import FileRow from "./FileRow.svelte";

interface Props {
	files: FileStatus[];
	treeMode: boolean;
	actionLabel: string;
	loadingFiles?: Set<string>;
	onfileaction: (path: string) => void;
	onfileclick?: (path: string) => void;
	onfilecontextmenu?: (e: MouseEvent, path: string, status: FileStatus) => void;
	ondirectoryaction?: (dirPath: string) => void;
	ondirectorycontextmenu?: (e: MouseEvent, dirPath: string) => void;
	selectedPath?: string | null;
	expandAllSignal?: number;
	collapseAllSignal?: number;
	/** path → review-comment count for this list's OID. Empty (default) hides
	 *  all badges, which is how the toggle/active gate reaches the rows. */
	commentCounts?: Map<string, number>;
	commentTallies?: Map<string, ReviewTally>;
}

let {
	files,
	treeMode,
	actionLabel,
	loadingFiles,
	onfileaction,
	onfileclick,
	onfilecontextmenu,
	ondirectoryaction,
	ondirectorycontextmenu,
	selectedPath = null,
	expandAllSignal = 0,
	collapseAllSignal = 0,
	commentCounts,
	commentTallies,
}: Props = $props();

let expanded = $state<Set<string>>(new Set());
let focusIndex = $state(0);
let lastFocusedPath = $state<string | null>(null);
let list = $state<HTMLElement>();
let listFocused = $state(false);
// The part of the list in sight, in the list's own content coordinates.
let viewTop = $state(0);
let viewHeight = $state(0);

// The cursor is drawn only while the list holds the focus, where the arrow
// keys move it. Otherwise the open file is drawn as selected, and no row is
// while no file is open, so a list the user never touched shows no selection.
function isMarked(index: number, row: FlatRow): boolean {
	if (listFocused) return index === focusIndex;
	return row.type === "file" && row.node.file.path === selectedPath;
}

function holdsBusyFile(directory: DirectoryNode): boolean {
	const busy = loadingFiles;
	if (!busy?.size) return false;

	return collectFilePaths(directory.children).some((path) => busy.has(path));
}

function trackFocusLeaving(e: FocusEvent) {
	const next = e.relatedTarget;
	listFocused = next instanceof Node && list?.contains(next) === true;
}

// Track previous tree mode to detect actual changes (not initial render)
let prevTreeMode: boolean | undefined;

let tree = $derived(buildTree(files));
let dirPaths = $derived(collectDirPaths(tree));

// Migrate expanded paths when tree structure changes (e.g. directory compression)
$effect(() => {
	const current = untrack(() => expanded);
	const migrated = migrateExpanded(current, dirPaths);
	if (migrated) {
		expanded = migrated;
	}
});

let flatRows = $derived<FlatRow[]>(
	treeMode
		? flattenTree(tree, expanded)
		: files.map((f) => ({
				type: "file" as const,
				depth: 0,
				node: { type: "file" as const, name: f.path, path: f.path, file: f },
				parentPath: null,
			})),
);

// Start the new layout with its folders closed except the route to the open file.
$effect(() => {
	const currentMode = treeMode;
	if (prevTreeMode !== undefined && prevTreeMode !== currentMode) {
		const path = selectedPath;
		expanded = new Set(
			currentMode && path
				? [...dirPaths].filter((dir) => path.startsWith(`${dir}/`))
				: [],
		);
		focusIndex = 0;
		lastFocusedPath = null;
	}
	prevTreeMode = currentMode;
});

// Expand All signal: when incremented, expand all directories
let prevExpandAll = 0;
$effect(() => {
	if (expandAllSignal > 0 && expandAllSignal !== prevExpandAll) {
		prevExpandAll = expandAllSignal;
		expanded = dirPaths;
	}
});

// Collapse All signal: when incremented, collapse all directories
let prevCollapseAll = 0;
$effect(() => {
	if (collapseAllSignal > 0 && collapseAllSignal !== prevCollapseAll) {
		prevCollapseAll = collapseAllSignal;
		expanded = new Set();
	}
});

// Sync focusIndex when parent sets selectedPath (e.g. auto-advance)
$effect(() => {
	if (selectedPath && flatRows.length > 0) {
		const idx = flatRows.findIndex(
			(r) => r.type === "file" && r.node.file.path === selectedPath,
		);
		if (idx >= 0) {
			focusIndex = idx;
			lastFocusedPath = selectedPath;
			untrack(() => revealRow(idx));
		}
	}
});

// Focus preservation on data change (D-13)
$effect(() => {
	// Track files array changes
	void files.length;
	if (lastFocusedPath && flatRows.length > 0) {
		const newIdx = findFocusIndex(flatRows, lastFocusedPath);
		const row = flatRows[newIdx];
		const rowPath = row?.node.path;
		if (rowPath === lastFocusedPath) {
			focusIndex = newIdx;
		} else {
			focusIndex = Math.min(focusIndex, Math.max(0, flatRows.length - 1));
		}
	} else if (flatRows.length > 0) {
		focusIndex = Math.min(focusIndex, flatRows.length - 1);
	} else {
		focusIndex = 0;
	}
});

// Only the rows in sight, and as much again either side, are built: a status
// change replaces the list, and building every row of a few thousand changed
// files froze the panel for most of a second. Spacers stand in for the rest, so
// the list is as tall as all its rows and a section sized by its content sizes
// the same. What is in sight is whatever the list's own box and every box
// around it that clips leave showing, since the staging panel scrolls the list
// itself while a commit's details scroll the pane the list sits in.
const offsets = $derived(
	buildOffsets(Array.from({ length: flatRows.length }, () => ROW_HEIGHT)),
);
const shown = $derived(windowFor(offsets, viewTop, viewHeight, viewHeight));
const shownRows = $derived(flatRows.slice(shown.start, shown.end));

let clips: HTMLElement[] = [];

/** The list, then each ancestor that clips what overflows it. */
function clipsAround(el: HTMLElement): HTMLElement[] {
	const found = [el];
	for (let box = el.parentElement; box; box = box.parentElement) {
		if (getComputedStyle(box).overflowY !== "visible") found.push(box);
	}
	return found;
}

/** The viewport band the clipping boxes leave open, in viewport coordinates. */
function openBand(boxes: HTMLElement[]): { top: number; bottom: number } {
	let top = Number.NEGATIVE_INFINITY;
	let bottom = Number.POSITIVE_INFINITY;
	for (const box of boxes) {
		const rect = box.getBoundingClientRect();
		top = Math.max(top, rect.top);
		bottom = Math.min(bottom, rect.bottom);
	}
	return { top, bottom };
}

function measureView() {
	const el = list;
	if (!el) return;

	const band = openBand(clips);
	const listTop = el.getBoundingClientRect().top;
	viewTop = el.scrollTop + Math.max(0, band.top - listTop);
	viewHeight = Math.max(0, band.bottom - band.top);
}

$effect(() => {
	const el = list;
	if (!el) return;

	clips = clipsAround(el);
	measureView();
	const observer = new ResizeObserver(measureView);
	for (const box of clips) {
		observer.observe(box);
		box.addEventListener("scroll", measureView, { passive: true });
	}
	return () => {
		observer.disconnect();
		for (const box of clips) box.removeEventListener("scroll", measureView);
		clips = [];
	};
});

/** Scrolls the least distance that shows the whole row, and not at all when it
 *  already shows, so the cursor never moves out of sight. The list scrolls when
 *  it overflows, and otherwise the nearest box around it that does. */
function revealRow(index: number) {
	const el = list;
	if (!el || index < 0 || index >= flatRows.length) return;

	// A selection made as the list mounts arrives before the boxes are gathered.
	const boxes = clips.length > 0 ? clips : clipsAround(el);
	const band = openBand(boxes);
	const contentTop = el.getBoundingClientRect().top - el.scrollTop;
	const top = contentTop + offsets[index];
	const bottom = contentTop + offsets[index + 1];
	const by =
		top < band.top
			? top - band.top
			: bottom > band.bottom
				? bottom - band.bottom
				: 0;
	if (by === 0) return;

	const scroller =
		boxes.find((box) => box.scrollHeight > box.clientHeight) ?? el;
	scroller.scrollTop += by;
	measureView();
}

const LIST = "flex-1 overflow-y-auto min-h-0 outline-none";

function focusRow(index: number, path: string) {
	focusIndex = index;
	lastFocusedPath = path;
}

function takeFocus() {
	list?.focus({ preventScroll: true });
}

function toggleExpanded(path: string) {
	const next = new Set(expanded);
	if (next.has(path)) {
		next.delete(path);
	} else {
		next.add(path);
	}
	expanded = next;
}

function handleKeydown(e: KeyboardEvent) {
	if (flatRows.length === 0) return;
	const row = flatRows[focusIndex];
	if (!row) return;
	const prevIndex = focusIndex;
	// A directory's button holds the focus once clicked and answers Enter and
	// Space itself, so the list leaves those two to it.
	const fromRow = e.target !== e.currentTarget;

	switch (e.key) {
		case "ArrowDown":
			e.preventDefault();
			focusIndex = Math.min(focusIndex + 1, flatRows.length - 1);
			break;
		case "ArrowUp":
			e.preventDefault();
			focusIndex = Math.max(focusIndex - 1, 0);
			break;
		case "ArrowRight":
			e.preventDefault();
			if (row.type === "directory") {
				if (!row.expanded) {
					toggleExpanded(row.node.path);
				} else {
					// Move to first child
					focusIndex = Math.min(focusIndex + 1, flatRows.length - 1);
				}
			}
			break;
		case "ArrowLeft":
			e.preventDefault();
			if (row.type === "directory" && row.expanded) {
				toggleExpanded(row.node.path);
			} else if (row.parentPath) {
				// Jump to parent directory
				const parentIdx = flatRows.findIndex(
					(r) => r.type === "directory" && r.node.path === row.parentPath,
				);
				if (parentIdx >= 0) focusIndex = parentIdx;
			}
			break;
		case "Enter":
			if (fromRow) break;
			e.preventDefault();
			if (row.type === "file") {
				onfileclick?.(row.node.file.path);
			} else {
				toggleExpanded(row.node.path);
			}
			break;
		case " ":
			if (fromRow) break;
			if (row.type === "directory") {
				e.preventDefault();
				toggleExpanded(row.node.path);
			}
			break;
	}
	if (focusIndex !== prevIndex) {
		if (fromRow) takeFocus();
		revealRow(focusIndex);
	}

	// Track focused path for preservation across data changes
	const focusedRow = flatRows[focusIndex];
	lastFocusedPath = focusedRow?.node.path ?? null;

	// Emit selection on arrow navigation so the diff pane updates
	if (
		(e.key === "ArrowDown" || e.key === "ArrowUp") &&
		focusIndex !== prevIndex
	) {
		if (focusedRow?.type === "file") {
			onfileclick?.(focusedRow.node.file.path);
		}
	}
}
</script>

{#snippet rows()}
	<div aria-hidden="true" style:height="{shown.offsetTop}px"></div>
	{#each shownRows as row, shownIndex (`${row.type}:${row.node.path}`)}
		{@const i = shown.start + shownIndex}
		{#if row.type === "directory"}
			<DirectoryRow
				node={row.node}
				depth={row.depth}
				expanded={row.expanded}
				selected={isMarked(i, row)}
				ontoggle={() => {
					focusRow(i, row.node.path);
					toggleExpanded(row.node.path);
				}}
				actionLabel={ondirectoryaction ? actionLabel : ""}
				onaction={ondirectoryaction
					? () => ondirectoryaction(row.node.path)
					: undefined}
				oncontextmenu={ondirectorycontextmenu
					? (e) => ondirectorycontextmenu(e, row.node.path)
					: undefined}
				{commentCounts}
				{commentTallies}
				isLoading={holdsBusyFile(row.node)}
			/>
		{:else}
			<FileRow
				file={row.node.file}
				role={treeMode ? "treeitem" : "option"}
				{actionLabel}
				isLoading={loadingFiles?.has(row.node.file.path) ?? false}
				onaction={() => onfileaction(row.node.file.path)}
				onclick={() => {
					focusRow(i, row.node.file.path);
					onfileclick?.(row.node.file.path);
				}}
				onfocus={takeFocus}
				oncontextmenu={onfilecontextmenu
					? (e) => onfilecontextmenu(e, row.node.file.path, row.node.file)
					: undefined}
				depth={treeMode ? row.depth : 0}
				selected={isMarked(i, row)}
				commentCount={commentCounts?.get(row.node.file.path) ?? 0}
				commentTally={commentTallies?.get(row.node.file.path) ?? null}
			/>
		{/if}
	{/each}
	<div
		aria-hidden="true"
		style:height="{shown.totalHeight - offsets[shown.end]}px"
	></div>
{/snippet}

<!--
	The list holds the focus and the keys for its files, so a file's button
	hands the focus back when a click gives it. The role is written out in each
	branch, since the compiler accepts a tabindex only on a role it can read.
-->
{#if treeMode}
	<div
		bind:this={list}
		role="tree"
		tabindex="0"
		onkeydown={handleKeydown}
		onfocusin={() => (listFocused = true)}
		onfocusout={trackFocusLeaving}
		class={LIST}
		class:cursor-active={listFocused}
	>
		{@render rows()}
	</div>
{:else}
	<div
		bind:this={list}
		role="listbox"
		tabindex="0"
		onkeydown={handleKeydown}
		onfocusin={() => (listFocused = true)}
		onfocusout={trackFocusLeaving}
		class={LIST}
		class:cursor-active={listFocused}
	>
		{@render rows()}
	</div>
{/if}

<style>
.cursor-active :global([aria-selected="true"]) {
	box-shadow: inset 2px 0 0 var(--color-accent);
}
</style>
