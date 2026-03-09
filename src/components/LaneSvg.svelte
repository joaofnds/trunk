<script lang="ts">
  import type { GraphCommit, GraphEdge } from '../lib/types.js';

  interface Props {
    commit: GraphCommit;
    laneWidth?: number;
    rowHeight?: number;
    maxColumns?: number;
    wipAbove?: boolean;
  }

  let { commit, laneWidth = 12, rowHeight = 26, maxColumns = 1, wipAbove = false }: Props = $props();

  const cx = (col: number) => col * laneWidth + laneWidth / 2;
  const cy = $derived(rowHeight / 2);
  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
  const svgWidth = $derived(Math.max(maxColumns, commit.column + 1) * laneWidth);
  const cornerRadius = $derived(laneWidth / 2);

  const straightEdges = $derived(
    commit.edges.filter((e) => e.from_column === e.to_column)
  );

  const connectionEdges = $derived(
    commit.edges.filter((e) => e.from_column !== e.to_column)
  );

  function buildEdgePath(edge: GraphEdge): string {
    const x1 = cx(edge.from_column);
    const x2 = cx(edge.to_column);
    const r = cornerRadius;
    const goingRight = edge.to_column > edge.from_column;

    // Horizontal target: stop short by cornerRadius for the arc
    const hTarget = goingRight ? x2 - r : x2 + r;

    switch (edge.edge_type) {
      case 'MergeLeft':
      case 'MergeRight': {
        // From commit dot → horizontal toward parent col → arc down → vertical to row bottom
        const sweep = goingRight ? 1 : 0;
        return `M ${x1} ${cy} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${cy + r} V ${rowHeight + 0.5}`;
      }
      case 'ForkLeft':
      case 'ForkRight': {
        // From parent dot → horizontal toward branch col → arc up → vertical to row top
        const sweep = goingRight ? 0 : 1;
        return `M ${x1} ${cy} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${cy - r} V ${-0.5}`;
      }
      default:
        return '';
    }
  }
</script>

<svg width={svgWidth} height={rowHeight} style="overflow: visible; flex-shrink: 0;">
  <!-- Layer 1: Vertical rail lines (bottom) -->
  {#if commit.oid === '__wip__'}
    <line
      x1={cx(0)} y1={cy} x2={cx(0)} y2={rowHeight + 0.5}
      stroke={laneColor(0)}
      stroke-width={2.5}
      stroke-dasharray="4 3"
      stroke-linecap="round"
    />
  {:else}
    {#each straightEdges as edge}
      <line
        x1={cx(edge.from_column)}
        y1={commit.is_branch_tip && edge.from_column === commit.column && !wipAbove ? cy : -0.5}
        x2={cx(edge.to_column)}
        y2={rowHeight + 0.5}
        stroke={laneColor(edge.color_index)}
        stroke-width={2.5}
        stroke-linecap="round"
      />
    {/each}
  {/if}

  <!-- Layer 2: Merge/Fork connection paths (middle) -->
  {#each connectionEdges as edge}
    <path
      d={buildEdgePath(edge)}
      fill="none"
      stroke={laneColor(edge.color_index)}
      stroke-width={2.5}
      stroke-linecap="round"
    />
  {/each}

  <!-- Layer 3: Commit dot (top) -->
  {#if commit.oid === '__wip__'}
    <circle
      cx={cx(commit.column)}
      cy={cy}
      r={4}
      fill="none"
      stroke={laneColor(0)}
      stroke-width={2}
      stroke-dasharray="3 2"
    />
  {:else if commit.is_merge}
    <circle
      cx={cx(commit.column)}
      cy={cy}
      r={4}
      fill="var(--color-bg)"
      stroke={laneColor(commit.color_index)}
      stroke-width={2}
    />
  {:else}
    <circle
      cx={cx(commit.column)}
      cy={cy}
      r={4}
      fill={laneColor(commit.color_index)}
    />
  {/if}
</svg>
