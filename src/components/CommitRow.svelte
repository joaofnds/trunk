<script lang="ts">
  import type { GraphCommit } from '../lib/types.js';
  import LaneSvg from './LaneSvg.svelte';
  import RefPill from './RefPill.svelte';

  interface Props {
    commit: GraphCommit;
    onselect?: (oid: string) => void;
    maxColumns?: number;
  }

  let { commit, onselect, maxColumns = 1 }: Props = $props();
</script>

<div
  class="flex items-center h-[26px] px-2 hover:bg-[var(--color-surface)] cursor-pointer text-[13px]"
  style="color: var(--color-text);"
  onclick={() => onselect?.(commit.oid)}
>
  <!-- Ref pills (fixed-width, left column) -->
  <div class="flex items-center overflow-hidden flex-shrink-0" style="width: 120px;">
    <RefPill refs={commit.refs} />
  </div>

  <!-- Lane SVG (center, flex-shrink: 0 to avoid compression) -->
  <LaneSvg {commit} {maxColumns} />

  <!-- Commit message (right, fills remaining space) -->
  <div class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap ml-2">
    <span class="text-[var(--color-text-muted)] mr-1.5 font-mono text-[11px]"
      >{commit.short_oid}</span
    >{commit.summary}
  </div>
</div>
