<script lang="ts">
  import type { GraphCommit } from '../lib/types.js';

  interface Props {
    commit: GraphCommit;
    laneWidth?: number;
    rowHeight?: number;
  }

  let { commit, laneWidth = 12, rowHeight = 26 }: Props = $props();

  const cx = (col: number) => col * laneWidth + laneWidth / 2;
  const cy = rowHeight / 2;
  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;

  const maxCol = $derived(
    Math.max(
      commit.column,
      ...commit.edges.flatMap((e) => [e.from_column, e.to_column])
    )
  );
  const svgWidth = $derived(Math.max((maxCol + 1) * laneWidth, laneWidth));
</script>

<svg width={svgWidth} height={rowHeight} style="overflow: visible; flex-shrink: 0;">
  <!-- Edges drawn first, below the commit dot -->
  {#each commit.edges as edge}
    {#if edge.edge_type === 'Straight'}
      <line
        x1={cx(edge.from_column)}
        y1={0}
        x2={cx(edge.to_column)}
        y2={rowHeight}
        stroke={laneColor(edge.color_index)}
        stroke-width="2"
      />
    {:else}
      <!-- ForkLeft, ForkRight, MergeLeft, MergeRight — Bézier curve -->
      <path
        d={`M ${cx(edge.from_column)} ${cy} C ${cx(edge.from_column)} ${rowHeight}, ${cx(edge.to_column)} ${0}, ${cx(edge.to_column)} ${rowHeight}`}
        fill="none"
        stroke={laneColor(edge.color_index)}
        stroke-width="2"
      />
    {/if}
  {/each}

  <!-- Commit dot -->
  <circle
    cx={cx(commit.column)}
    cy={cy}
    r={commit.is_merge ? 6 : 4}
    fill={laneColor(commit.column % 8)}
    stroke={commit.is_merge ? 'var(--color-bg)' : 'none'}
    stroke-width={commit.is_merge ? 2 : 0}
  />
</svg>
