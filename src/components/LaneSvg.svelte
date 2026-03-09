<script lang="ts">
  import type { GraphCommit } from '../lib/types.js';

  interface Props {
    commit: GraphCommit;
    laneWidth?: number;
    rowHeight?: number;
    maxColumns?: number;
  }

  let { commit, laneWidth = 12, rowHeight = 26, maxColumns = 1 }: Props = $props();

  const cx = (col: number) => col * laneWidth + laneWidth / 2;
  const cy = rowHeight / 2;
  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;

  const svgWidth = $derived(Math.max(maxColumns, commit.column + 1) * laneWidth);
</script>

<svg width={svgWidth} height={rowHeight} style="overflow: visible; flex-shrink: 0;">
  <!-- Commit dot -->
  <circle
    cx={cx(commit.column)}
    cy={cy}
    r={4}
    fill={laneColor(commit.color_index)}
  />
</svg>
