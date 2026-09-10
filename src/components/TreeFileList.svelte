<script lang="ts">
import { untrack } from "svelte";
import { buildTree } from "../lib/build-tree.js";
import type { FlatRow } from "../lib/flatten-tree.js";
import {
	collectDirPaths,
	findFocusIndex,
	flattenTree,
	migrateExpanded,
} from "../lib/flatten-tree.js";
import type { FileStatus, ReviewTone } from "../lib/types.js";
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
	commentTones?: Map<string, ReviewTone>;
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
	commentTones,
}: Props = $props();

let expanded = $state<Set<string>>(new Set());
let focusIndex = $state(0);
let lastFocusedPath = $state<string | null>(null);

// Track previous tree mode to detect actual changes (not initial render)
let prevTreeMode: boolean | undefined;

let tree = $derived(buildTree(files));

// Migrate expanded paths when tree structure changes (e.g. directory compression)
$effect(() => {
	const dirPaths = collectDirPaths(tree);
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

// Reset on mode change (D-09): when treeMode changes, reset expanded/focus
$effect(() => {
	const currentMode = treeMode;
	if (prevTreeMode !== undefined && prevTreeMode !== currentMode) {
		expanded = new Set();
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
		expanded = collectDirPaths(tree);
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
			e.preventDefault();
			if (row.type === "file") {
				onfileclick?.(row.node.file.path);
			} else {
				toggleExpanded(row.node.path);
			}
			break;
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  role={treeMode ? 'tree' : 'list'}
  tabindex="0"
  onkeydown={handleKeydown}
  style="flex: 1; overflow-y: auto; min-height: 0; outline: none;"
>
  {#each flatRows as row, i (row.type === 'file' ? row.node.path : `dir:${row.node.path}`)}
    {#if row.type === 'directory'}
      <DirectoryRow
        node={row.node}
        depth={row.depth}
        expanded={row.expanded}
        focused={i === focusIndex}
        ontoggle={() => { focusIndex = i; lastFocusedPath = row.node.path; toggleExpanded(row.node.path); }}
        actionLabel={ondirectoryaction ? actionLabel : ''}
        onaction={ondirectoryaction ? () => ondirectoryaction!(row.node.path) : undefined}
        oncontextmenu={ondirectorycontextmenu ? (e) => ondirectorycontextmenu!(e, row.node.path) : undefined}
        {commentCounts}
        {commentTones}
      />
    {:else}
      <FileRow
        file={row.node.file}
        actionLabel={actionLabel}
        isLoading={loadingFiles?.has(row.node.file.path) ?? false}
        onaction={() => onfileaction(row.node.file.path)}
        onclick={() => { focusIndex = i; lastFocusedPath = row.node.file.path; onfileclick?.(row.node.file.path); }}
        oncontextmenu={onfilecontextmenu ? (e) => onfilecontextmenu!(e, row.node.file.path, row.node.file) : undefined}
        depth={treeMode ? row.depth : 0}
        displayName={treeMode ? row.node.name : undefined}
        focused={i === focusIndex}
        commentCount={commentCounts?.get(row.node.file.path) ?? 0}
        commentTone={commentTones?.get(row.node.file.path) ?? null}
      />
    {/if}
  {/each}
</div>
