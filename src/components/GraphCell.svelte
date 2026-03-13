<script lang="ts">
  import { getContext } from 'svelte';
  import type { GraphCommit, SvgPathData } from '../lib/types.js';
  import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, WIP_STROKE, MERGE_STROKE } from '../lib/graph-constants.js';

  interface Props {
    commit: GraphCommit;
    rowIndex: number;
    maxColumns?: number;
  }

  let { commit, rowIndex, maxColumns = 1 }: Props = $props();

  const graphCtx = getContext<{ readonly data: Map<string, SvgPathData> }>('graphSvgData');

  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
  const svgWidth = $derived(Math.max(maxColumns, commit.column + 1) * LANE_WIDTH);

  const prefix = $derived(commit.oid + ':');

  const railPaths = $derived.by(() => {
    const result: SvgPathData[] = [];
    for (const [key, path] of graphCtx.data) {
      if (key.startsWith(prefix) && !path.dashed && (key.includes(':straight:') || key.includes(':rail:'))) {
        result.push(path);
      }
    }
    return result;
  });

  const connectionPaths = $derived.by(() => {
    const result: SvgPathData[] = [];
    for (const [key, path] of graphCtx.data) {
      if (key.startsWith(prefix) && !path.dashed && !key.includes(':straight:') && !key.includes(':rail:')) {
        result.push(path);
      }
    }
    return result;
  });

  const dashedPaths = $derived.by(() => {
    const result: SvgPathData[] = [];
    for (const [key, path] of graphCtx.data) {
      if (key.startsWith(prefix) && path.dashed) {
        result.push(path);
      }
    }
    return result;
  });

  const dotCx = $derived(commit.column * LANE_WIDTH + LANE_WIDTH / 2);
  const dotCy = $derived(rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2);
</script>

<svg width={svgWidth} height={ROW_HEIGHT} viewBox="0 {rowIndex * ROW_HEIGHT} {svgWidth} {ROW_HEIGHT}" style="overflow: hidden; flex-shrink: 0;">
  <!-- Layer 1: Rails (straight/rail paths) -->
  {#each railPaths as path}
    <path d={path.d} fill="none" stroke={laneColor(path.colorIndex)} stroke-width={EDGE_STROKE} stroke-linecap="butt" />
  {/each}

  <!-- Layer 2: Connection edges -->
  {#each connectionPaths as path}
    <path d={path.d} fill="none" stroke={laneColor(path.colorIndex)} stroke-width={EDGE_STROKE} stroke-linecap="round" />
  {/each}

  <!-- Layer 2.5: Dashed connector paths (WIP/stash) -->
  {#each dashedPaths as path}
    <path d={path.d} fill="none" stroke={laneColor(path.colorIndex)}
      stroke-width={WIP_STROKE} stroke-dasharray="1 4" stroke-dashoffset="-3" stroke-linecap="round" />
  {/each}

  <!-- Layer 3: Commit dot -->
  {#if commit.oid === '__wip__'}
    <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS}
      fill="none" stroke={laneColor(commit.color_index)}
      stroke-width={WIP_STROKE} stroke-dasharray="1 4" stroke-linecap="round" />
  {:else if commit.oid.startsWith('__stash_')}
    <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS}
      fill="none" stroke={laneColor(commit.color_index)}
      stroke-width={WIP_STROKE} stroke-dasharray="1 4" stroke-linecap="round" />
  {:else if commit.is_merge}
    <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS} fill="var(--color-bg)" stroke={laneColor(commit.color_index)} stroke-width={MERGE_STROKE} />
  {:else}
    <circle cx={dotCx} cy={dotCy} r={DOT_RADIUS} fill={laneColor(commit.color_index)} />
  {/if}
</svg>
