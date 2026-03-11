<script lang="ts">
  import type { GraphCommit, GraphEdge } from '../lib/types.js';
  import { LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, WIP_STROKE, MERGE_STROKE } from '../lib/graph-constants.js';

  interface Props {
    commit: GraphCommit;
    laneWidth?: number;
    rowHeight?: number;
    maxColumns?: number;
  }

  let { commit, laneWidth = LANE_WIDTH, rowHeight = ROW_HEIGHT, maxColumns = 1 }: Props = $props();

  const cx = (col: number) => col * laneWidth + laneWidth / 2;
  const cy = $derived(rowHeight / 2);
  const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
  const svgWidth = $derived(Math.max(maxColumns, commit.column + 1) * laneWidth);
  const cornerRadius = $derived(laneWidth / 2);

  const straightEdges = $derived(
    commit.edges.filter((e) => e.from_column === e.to_column)
  );

  // Non-branch-tip commits without a straight edge in their own column (e.g. root commits)
  // still need a rail connecting from above to their dot
  const needsIncomingRail = $derived(
    !commit.is_branch_tip &&
    commit.oid !== '__wip__' &&
    !straightEdges.some((e) => e.from_column === commit.column)
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
        return `M ${x1} ${cy} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${cy + r} V ${rowHeight}`;
      }
      case 'ForkLeft':
      case 'ForkRight': {
        // From parent dot → horizontal toward branch col → arc up → vertical to row top
        const sweep = goingRight ? 0 : 1;
        return `M ${x1} ${cy} H ${hTarget} A ${r} ${r} 0 0 ${sweep} ${x2} ${cy - r} V ${0}`;
      }
      default:
        return '';
    }
  }
</script>

<svg width={svgWidth} height={rowHeight} style="overflow: visible; flex-shrink: 0;">
  <!-- Layer 1: Vertical rail lines (bottom) -->
  {#if commit.oid === '__wip__'}
    <!-- Single continuous dotted line from WIP circle to HEAD dot in next row -->
    <line
      x1={cx(0)} y1={cy + DOT_RADIUS} x2={cx(0)} y2={rowHeight + cy}
      stroke={laneColor(0)}
      stroke-width={WIP_STROKE}
      stroke-dasharray="1 4"
      stroke-dashoffset="-3"
      stroke-linecap="round"
    />
  {:else}
    {#each straightEdges as edge}
      <line
        x1={cx(edge.from_column)}
        y1={commit.is_branch_tip && edge.from_column === commit.column ? cy : 0}
        x2={cx(edge.to_column)}
        y2={rowHeight}
        stroke={laneColor(edge.color_index)}
        stroke-width={EDGE_STROKE}
        stroke-linecap="butt"
      />
    {/each}
    {#if needsIncomingRail}
      <line
        x1={cx(commit.column)}
        y1={0}
        x2={cx(commit.column)}
        y2={cy}
        stroke={laneColor(commit.color_index)}
        stroke-width={EDGE_STROKE}
        stroke-linecap="butt"
      />
    {/if}
  {/if}

  <!-- Layer 2: Merge/Fork connection paths (middle) -->
  {#each connectionEdges as edge}
    <path
      d={buildEdgePath(edge)}
      fill="none"
      stroke={laneColor(edge.color_index)}
      stroke-width={EDGE_STROKE}
      stroke-linecap="round"
    />
  {/each}

  <!-- Layer 3: Commit dot (top) -->
  {#if commit.oid === '__wip__'}
    <circle
      cx={cx(commit.column)}
      cy={cy}
      r={DOT_RADIUS}
      fill="none"
      stroke={laneColor(0)}
      stroke-width={WIP_STROKE}
      stroke-dasharray="1 4"
      stroke-linecap="round"
    />
  {:else if commit.is_merge}
    <circle
      cx={cx(commit.column)}
      cy={cy}
      r={DOT_RADIUS}
      fill="var(--color-bg)"
      stroke={laneColor(commit.color_index)}
      stroke-width={MERGE_STROKE}
    />
  {:else}
    <circle
      cx={cx(commit.column)}
      cy={cy}
      r={DOT_RADIUS}
      fill={laneColor(commit.color_index)}
    />
  {/if}
</svg>
