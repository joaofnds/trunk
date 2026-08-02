import {
	COLUMN_PADDING_X,
	DEFAULT_GRAPH_SETTINGS,
	ICON_GAP,
	ICON_WIDTH,
	PILL_FONT,
	PILL_FONT_BOLD,
	PILL_GAP,
	PILL_HEIGHT,
	PILL_MARGIN_LEFT,
	PILL_PADDING_X,
} from "./graph-constants.js";
import { truncateWithEllipsis } from "./text-measure.js";
import type {
	GraphCommit,
	GraphDisplaySettings,
	OverlayNode,
	OverlayRefPill,
	RefLabel,
} from "./types.js";

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
 */
export function isRemoteOnlyRef(ref: RefLabel, allRefs: RefLabel[]): boolean {
	if (ref.ref_type !== "RemoteBranch") return false;
	return !allRefs.some(
		(r) => r !== ref && (r.ref_type === "LocalBranch" || r.ref_type === "Tag"),
	);
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
 * @param settings - Display settings controlling row/lane dimensions. Defaults to
 *   DEFAULT_GRAPH_SETTINGS. Pass reactive settings from a future user preferences
 *   store to make pill positions update without code changes.
 */
export function buildRefPillData(
	nodes: OverlayNode[],
	commits: GraphCommit[],
	refColumnWidth: number,
	measureFn: (text: string, font: string) => number,
	settings: GraphDisplaySettings = DEFAULT_GRAPH_SETTINGS,
): OverlayRefPill[] {
	const cx = (col: number): number =>
		col * settings.laneWidth + settings.laneWidth / 2;
	const cy = (row: number): number =>
		row * settings.rowHeight + settings.rowHeight / 2;
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

		// All ref types include icon width (Laptop for local, Globe for remote, Tag for tag, Archive for stash)
		const iconWidth = ICON_WIDTH;

		// Compute available text width
		const badgeWidth =
			overflowCount > 0 ? PILL_GAP + estimateBadgeWidth(overflowCount) : 0;
		// Right gap matches the dot's visual inset: COLUMN_PADDING_X + (laneWidth/2 - dotRadius)
		// so the pill and first dot are equidistant from the column divider
		const dotInset = settings.laneWidth / 2 - settings.dotRadius;
		const maxTextWidth =
			refColumnWidth -
			PILL_MARGIN_LEFT -
			COLUMN_PADDING_X -
			dotInset -
			PILL_PADDING_X * 2 -
			iconWidth -
			ICON_GAP -
			badgeWidth;

		// Measure and truncate text
		const font = primary.is_head ? PILL_FONT_BOLD : PILL_FONT;
		const { text: truncatedLabel, width: textWidth } = truncateWithEllipsis(
			primary.short_name,
			maxTextWidth,
			font,
			measureFn,
		);

		// Compute pill width — ceil textWidth to avoid sub-pixel rounding gaps
		const pillWidth =
			Math.ceil(textWidth) + PILL_PADDING_X * 2 + iconWidth + ICON_GAP;

		pills.push({
			x: PILL_MARGIN_LEFT,
			y: cy(node.y),
			width: pillWidth,
			textWidth,
			height: PILL_HEIGHT,
			name: primary.name,
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
			isHollow: node.isMerge || node.isStash || node.isWip,
		});
	}

	return pills;
}
