<script lang="ts">
  import type { GraphCommit } from '../lib/types.js';
  import type { ColumnWidths, ColumnVisibility } from '../lib/store.js';
  import { LANE_WIDTH, ROW_HEIGHT, EDGE_STROKE } from '../lib/graph-constants.js';
  import LaneSvg from './LaneSvg.svelte';
  import RefPill from './RefPill.svelte';

  interface Props {
    commit: GraphCommit;
    onselect?: (oid: string) => void;
    maxColumns?: number;
    columnWidths: ColumnWidths;
    columnVisibility: ColumnVisibility;
  }

  let { commit, onselect, maxColumns = 1, columnWidths, columnVisibility }: Props = $props();

  function relativeDate(ts: number): string {
    if (ts === 0) return '';
    const now = Date.now() / 1000;
    const diff = Math.max(0, now - ts);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
    return `${Math.floor(diff / 31536000)}y ago`;
  }

  const isWip = $derived(commit.oid === '__wip__');

  const allRemoteOnly = $derived(
    commit.refs.length > 0 &&
    commit.refs.every(r => r.ref_type === 'RemoteBranch')
  );

  let refContainerWidth = $state(0);
  let refHovered = $state(false);
</script>

<div
  class="relative flex items-center px-2 hover:bg-[var(--color-surface)] cursor-pointer text-[13px]"
  style:height="{ROW_HEIGHT}px"
  style="color: var(--color-text); {refHovered ? 'z-index: 10;' : ''}"
  onclick={() => onselect?.(commit.oid)}
>
  <!-- Connector line + Column 1: Branch/Tag refs (hidden together) -->
  {#if columnVisibility.ref}
    {#if commit.refs.length > 0 && commit.oid !== '__wip__' && columnVisibility.graph}
      <div
        class="absolute pointer-events-none"
        style="left: {12 + refContainerWidth}px; width: {columnWidths.ref - refContainerWidth - 4 + commit.column * LANE_WIDTH + LANE_WIDTH / 2}px; top: 50%; height: {EDGE_STROKE}px; transform: translateY(-50%); background: var(--lane-{commit.color_index % 8}); opacity: {allRemoteOnly ? 0.5 : 1}; z-index: 0;{commit.is_head ? '' : ' filter: brightness(0.75);'}"
      ></div>
    {/if}

    <div
      class="relative z-[1] flex items-center flex-shrink-0 pl-1 pr-1 {refHovered ? 'overflow-visible' : 'overflow-hidden'}"
      style="width: {columnWidths.ref}px;"
      onmouseenter={() => refHovered = true}
      onmouseleave={() => refHovered = false}
    >
      <!-- Default: first pill + overflow count -->
      <div class="flex items-center" bind:clientWidth={refContainerWidth}>
        <RefPill refs={commit.refs} />
      </div>
      {#if commit.refs.length > 1}
        <!-- +N badge; hidden while overlay is visible so there's no double-badge -->
        <div class="relative ml-1 flex-shrink-0">
          <span
            class="inline-flex items-center rounded-full px-1 text-[10px] leading-4 whitespace-nowrap font-medium cursor-default"
            style="background: var(--lane-{commit.refs[0].color_index % 8}); color: white; filter: brightness(0.75);"
            title={commit.refs.slice(1).map((r) => r.short_name).join(', ')}
          >
            +{commit.refs.length - 1}
          </span>
          <!-- Expanded overlay: single pill listing all branches, clip-path reveals from top-left -->
          <div
            class="absolute left-0 top-0 z-50 rounded-lg shadow-lg"
            style="
              background: var(--lane-{commit.refs[0].color_index % 8});
              padding: 4px 8px;
              white-space: nowrap;
              clip-path: {refHovered ? 'inset(0 0% 0% 0 round 8px)' : 'inset(0 100% 100% 0 round 8px)'};
              opacity: {refHovered ? '1' : '0'};
              transition: clip-path 180ms ease, opacity 120ms ease;
              pointer-events: {refHovered ? 'auto' : 'none'};
            "
          >
            {#each commit.refs.slice(1) as ref}
              <div class="text-[11px] leading-5 font-medium text-white whitespace-nowrap">{ref.short_name}</div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Column 2: Graph -->
  {#if columnVisibility.graph}
    <div class="relative z-[1] flex items-center flex-shrink-0" style="width: {columnWidths.graph}px; min-width: {Math.max(maxColumns, commit.column + 1) * LANE_WIDTH}px;">
      <LaneSvg {commit} {maxColumns} />
    </div>
  {/if}

  <!-- Column 3: Message (flex-1, always visible) -->
  {#if isWip}
    <div class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap italic px-1" style="color: var(--color-text-muted);">
      {commit.summary}
    </div>
  {:else}
    <div class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap px-1">
      {commit.summary}
    </div>
  {/if}

  <!-- Column 4: Author -->
  {#if columnVisibility.author}
    <div class="flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] px-1" style="width: {columnWidths.author}px; color: var(--color-text-muted);">
      {#if !isWip}{commit.author_name}{/if}
    </div>
  {/if}

  <!-- Column 5: Date -->
  {#if columnVisibility.date}
    <div class="flex-shrink-0 overflow-hidden whitespace-nowrap text-[11px] px-1" style="width: {columnWidths.date}px; color: var(--color-text-muted);">
      {#if !isWip}{relativeDate(commit.author_timestamp)}{/if}
    </div>
  {/if}

  <!-- Column 6: SHA -->
  {#if columnVisibility.sha}
    <div class="flex-shrink-0 font-mono text-[11px] px-1" style="width: {columnWidths.sha}px; color: var(--color-text-muted);">
      {#if !isWip}{commit.short_oid}{/if}
    </div>
  {/if}
</div>
