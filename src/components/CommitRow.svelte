<script lang="ts">
  import type { GraphCommit } from '../lib/types.js';
  import type { ColumnWidths } from '../lib/store.js';
  import LaneSvg from './LaneSvg.svelte';
  import RefPill from './RefPill.svelte';

  interface Props {
    commit: GraphCommit;
    onselect?: (oid: string) => void;
    maxColumns?: number;
    columnWidths: ColumnWidths;
  }

  let { commit, onselect, maxColumns = 1, columnWidths }: Props = $props();

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
</script>

<div
  class="relative flex items-center h-[26px] px-2 hover:bg-[var(--color-surface)] cursor-pointer text-[13px]"
  style="color: var(--color-text);"
  onclick={() => onselect?.(commit.oid)}
>
  <!-- Connector line: spans from after pills to commit dot in graph column -->
  {#if commit.refs.length > 0 && commit.oid !== '__wip__'}
    <div
      class="absolute pointer-events-none"
      style="left: {8 + refContainerWidth}px; width: {columnWidths.ref - refContainerWidth + commit.column * 12 + 6}px; top: 50%; height: 1.5px; transform: translateY(-50%); background: var(--lane-{commit.color_index % 8}); opacity: {allRemoteOnly ? 0.5 : 1}; z-index: 0;{commit.is_head ? '' : ' filter: brightness(0.75);'}"
    ></div>
  {/if}

  <!-- Column 1: Branch/Tag refs -->
  <div class="relative z-[1] flex items-center overflow-hidden flex-shrink-0 pl-1 pr-1" style="width: {columnWidths.ref}px;">
    <div class="flex items-center" bind:clientWidth={refContainerWidth}>
      <RefPill refs={commit.refs} />
    </div>
    {#if commit.refs.length > 1}
      <span
        class="relative z-[1] inline-flex items-center rounded-full px-1 text-[10px] leading-4 whitespace-nowrap font-medium ml-1 cursor-default"
        style="background: var(--lane-{commit.refs[0].color_index % 8}); color: white; filter: brightness(0.75);"
        title={commit.refs.slice(1).map((r) => r.short_name).join(', ')}
      >
        +{commit.refs.length - 1}
      </span>
    {/if}
  </div>

  <!-- Column 2: Graph -->
  <div class="relative z-[1] flex items-center flex-shrink-0" style="width: {columnWidths.graph}px; min-width: {Math.max(maxColumns, commit.column + 1) * 12}px;">
    <LaneSvg {commit} {maxColumns} />
  </div>

  <!-- Column 3: Message (flex-1) -->
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
  <div class="flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] px-1" style="width: {columnWidths.author}px; color: var(--color-text-muted);">
    {#if !isWip}{commit.author_name}{/if}
  </div>

  <!-- Column 5: Date -->
  <div class="flex-shrink-0 overflow-hidden whitespace-nowrap text-[11px] px-1" style="width: {columnWidths.date}px; color: var(--color-text-muted);">
    {#if !isWip}{relativeDate(commit.author_timestamp)}{/if}
  </div>

  <!-- Column 6: SHA -->
  <div class="flex-shrink-0 font-mono text-[11px] px-1" style="width: {columnWidths.sha}px; color: var(--color-text-muted);">
    {#if !isWip}{commit.short_oid}{/if}
  </div>
</div>
