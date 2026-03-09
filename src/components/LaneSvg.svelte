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

  const svgWidth = $derived((commit.column + 1) * laneWidth);
</script>

<svg width={svgWidth} height={rowHeight} style="overflow: visible; flex-shrink: 0;">
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
