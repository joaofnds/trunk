<script lang="ts">
import Minus from "@lucide/svelte/icons/minus";
import Plus from "@lucide/svelte/icons/plus";
import { treeIndent } from "../lib/chrome-heights.js";
import { renamePartsOf } from "../lib/rename-display.js";
import { STATUS_BADGES, UNKNOWN_STATUS_BADGE } from "../lib/status-badges.js";
import type { FileStatus } from "../lib/types.js";
import CommentBadge from "./CommentBadge.svelte";

interface Props {
	file: FileStatus;
	isLoading?: boolean;
	actionLabel: string;
	onaction: () => void;
	onclick?: () => void;
	oncontextmenu?: (e: MouseEvent) => void;
	depth?: number;
	displayName?: string;
	focused?: boolean;
	commentCount?: number;
}

let {
	file,
	isLoading = false,
	actionLabel,
	onaction,
	onclick,
	oncontextmenu,
	depth = 0,
	displayName,
	focused = false,
	commentCount = 0,
}: Props = $props();

let hovered = $state(false);

let badge = $derived(STATUS_BADGES[file.status] ?? UNKNOWN_STATUS_BADGE);

// A rename names both paths. Tree mode has already shortened the new path to
// its basename and the tree's own nesting says where the file is, so the old
// side shortens to its basename too rather than sitting beside it at full
// length.
let rename = $derived.by(() => {
	const parts = renamePartsOf(file.path, file.old_path ?? null);
	if (parts === null || displayName === undefined) return parts;

	return {
		from: parts.from.split("/").pop() ?? parts.from,
		to: displayName,
	};
});

let badgeBg = $derived(
	isLoading
		? "transparent"
		: `color-mix(in oklch, ${badge.color} 6%, transparent)`,
);
</script>

<div
  data-testid="staging-file"
  role={depth > 0 ? 'treeitem' : 'listitem'}
  aria-level={depth > 0 ? depth + 1 : undefined}
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  onclick={() => onclick?.()}
  oncontextmenu={(e) => { if (oncontextmenu) { e.preventDefault(); oncontextmenu(e); } }}
  style="
    height: var(--row-h);
    padding: 0 var(--space-2) 0 {treeIndent(depth)};
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: {onclick ? 'pointer' : 'default'};
    background: {focused ? 'var(--color-tree-focus)' : hovered ? 'var(--bg-hover)' : 'transparent'};
    color: {isLoading ? 'var(--color-text-muted)' : 'var(--color-text)'};
  "
>
  <!-- Status badge -->
  <span style="
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 10px;
    line-height: 1;
    color: {isLoading ? 'var(--color-text-muted)' : badge.color};
    background: {badgeBg};
  ">{badge.letter}</span>

  <!-- Filename, or both paths when the file was renamed -->
  <span style="
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    font-size: 12px;
  ">
    {#if rename !== null}
      <!-- The old path yields its space first: it shrinks and ellipsizes while
           the new path, which is where the file is now, keeps its width. -->
      <span style="
        flex-shrink: 1;
        min-width: 2ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--color-text-muted);
      ">{rename.from}</span>
      <span aria-hidden="true" style="
        flex-shrink: 0;
        color: var(--color-text-muted);
      ">→</span>
      <span style="
        flex-shrink: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      ">{rename.to}</span>
    {:else}
      <span style="
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      ">{displayName ?? file.path}</span>
    {/if}
  </span>

  <!-- Review-comment count for this file -->
  <CommentBadge count={commentCount} />

  <!-- Hover action button (hidden during loading or when no actionLabel) -->
  {#if hovered && !isLoading && actionLabel}
    <button
      onclick={(e) => { e.stopPropagation(); onaction(); }}
      aria-label={actionLabel === '+' ? 'Stage file' : 'Unstage file'}
      style="
        background: none;
        border: none;
        cursor: pointer;
        color: {actionLabel === '+' ? 'var(--ok)' : 'var(--err)'};
        display: flex;
        align-items: center;
        padding: 0 var(--space-1);
        line-height: 1;
      "
    >
      {#if actionLabel === '+'}
        <Plus size={11} />
      {:else}
        <Minus size={11} />
      {/if}
    </button>
  {/if}
</div>
