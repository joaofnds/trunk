import type { GraphCommit, OverlayNode, OverlayRefPill, RefLabel } from './types.js';
import {
  PILL_HEIGHT,
  PILL_PADDING_X,
  PILL_FONT,
  PILL_FONT_BOLD,
  PILL_GAP,
  PILL_MARGIN_LEFT,
  ICON_WIDTH,
  LANE_WIDTH,
  ROW_HEIGHT,
  BADGE_FONT_SIZE,
} from './graph-constants.js';
import { truncateWithEllipsis } from './text-measure.js';

const cx = (col: number): number => col * LANE_WIDTH + LANE_WIDTH / 2;
const cy = (row: number): number => row * ROW_HEIGHT + ROW_HEIGHT / 2;

/** Type priority for sorting: lower = higher priority */
const TYPE_ORDER: Record<string, number> = {
  LocalBranch: 0,
  Tag: 1,
  Stash: 2,
  RemoteBranch: 3,
};

/**
 * Sort refs by priority: HEAD first, then by type order
 * (LocalBranch > Tag > Stash > RemoteBranch).
 */
export function sortRefs(refs: RefLabel[]): RefLabel[] {
  return [...refs].sort((a, b) => {
    // HEAD always first
    if (a.is_head && !b.is_head) return -1;
    if (!a.is_head && b.is_head) return 1;
    // Then by type order
    return (TYPE_ORDER[a.ref_type] ?? 99) - (TYPE_ORDER[b.ref_type] ?? 99);
  });
}

/**
 * Checks if a ref is "remote only" — it's a RemoteBranch with no sibling
 * LocalBranch or Tag on the same commit.
 * Preserves exact logic from RefPill.svelte.
 */
export function isRemoteOnlyRef(ref: RefLabel, allRefs: RefLabel[]): boolean {
  if (ref.ref_type !== 'RemoteBranch') return false;
  return !allRefs.some(
    (r) => r !== ref && (r.ref_type === 'LocalBranch' || r.ref_type === 'Tag'),
  );
}

/** Whether a ref type should show an icon (Tag, Stash) */
function hasIcon(refType: string): boolean {
  return refType === 'Tag' || refType === 'Stash';
}

/** Estimate "+N" badge width based on character count */
function estimateBadgeWidth(count: number): number {
  // "+N" text is small (BADGE_FONT_SIZE), estimate ~7px per char + padding
  const chars = `+${count}`.length;
  return chars * 7 + 6;
}

/**
 * Build ref pill data from overlay nodes and graph commits.
 *
 * Pure function that transforms overlay graph data into positioned, sized,
 * styled ref pill data ready for SVG rendering.
 *
 * @param nodes - OverlayNode[] from buildGraphData
 * @param commits - GraphCommit[] from API (same indexing as displayItems)
 * @param refColumnWidth - Available width for the ref pill column
 * @param measureFn - Text measurement function (injectable for testing)
 */
export function buildRefPillData(
  nodes: OverlayNode[],
  commits: GraphCommit[],
  refColumnWidth: number,
  measureFn: (text: string, font: string) => number,
): OverlayRefPill[] {
  const pills: OverlayRefPill[] = [];

  for (const node of nodes) {
    // Skip WIP and stash nodes
    if (node.isWip || node.isStash) continue;

    // Look up commit at this row
    const commit = commits[node.y];
    if (!commit || commit.refs.length === 0) continue;

    const sorted = sortRefs(commit.refs);
    const primary = sorted[0];
    const overflowCount = sorted.length - 1;

    // Compute icon width
    const iconWidth = hasIcon(primary.ref_type) ? ICON_WIDTH : 0;

    // Compute available text width
    const badgeWidth = overflowCount > 0 ? PILL_GAP + estimateBadgeWidth(overflowCount) : 0;
    const maxTextWidth = refColumnWidth - PILL_PADDING_X * 2 - iconWidth - badgeWidth;

    // Measure and truncate text
    const font = primary.is_head ? PILL_FONT_BOLD : PILL_FONT;
    const { text: truncatedLabel, width: textWidth } = truncateWithEllipsis(
      primary.short_name,
      maxTextWidth,
      font,
      measureFn,
    );

    // Compute pill width
    const pillWidth = textWidth + PILL_PADDING_X * 2 + iconWidth;

    pills.push({
      x: PILL_MARGIN_LEFT,
      y: cy(node.y),
      width: pillWidth,
      height: PILL_HEIGHT,
      label: primary.short_name,
      truncatedLabel,
      refType: primary.ref_type,
      colorIndex: primary.color_index,
      isHead: primary.is_head,
      isRemoteOnly: isRemoteOnlyRef(primary, sorted),
      isNonHead: !primary.is_head,
      overflowCount,
      allRefs: sorted,
      dotCx: cx(node.x),
      dotCy: cy(node.y),
      commitColorIndex: node.colorIndex,
      rowIndex: node.y,
    });
  }

  return pills;
}
