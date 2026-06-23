<script lang="ts">
import { Minus, Plus } from "@lucide/svelte";
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
    height: 26px;
    padding: 0 8px;
    padding-left: {8 + depth * 16}px;
    display: flex;
    align-items: center;
    gap: 6px;
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
    border-radius: var(--radius-s);
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 10px;
    line-height: 1;
    color: {isLoading ? 'var(--color-text-muted)' : badge.color};
    background: {badgeBg};
  ">{badge.letter}</span>

  <!-- Filename -->
  <span style="
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  ">
    {displayName ?? file.path}
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
        padding: 0 4px;
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
