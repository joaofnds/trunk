import { DEFAULT_GRAPH_SETTINGS } from "./graph-constants.js";
import type {
	GraphDisplaySettings,
	OverlayConnection,
	OverlayGraphData,
	OverlayNode,
	OverlayPath,
} from "./types.js";

// ─── Coordinate context ───────────────────────────────────────────────────────

/** Pre-computed coordinate helpers derived from display settings. */
export interface PathContext {
	cx: (col: number) => number;
	cy: (row: number) => number;
	/** Fixed corner radius for cubic bezier connections (= laneWidth / 2) */
	R: number;
	dotRadius: number;
}

export function makePathContext(s: GraphDisplaySettings): PathContext {
	const { rowHeight, laneWidth, dotRadius } = s;
	return {
		cx: (col) => col * laneWidth + laneWidth / 2,
		cy: (row) => row * rowHeight + rowHeight / 2,
		R: laneWidth / 2,
		dotRadius,
	};
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Kappa constant for cubic bezier quarter-circle approximation.
 * κ = 4(√2−1)/3 ≈ 0.5522847498
 * Control point offset = R * κ
 */
const KAPPA = (4 * (Math.SQRT2 - 1)) / 3;

/** Gap between path end and hollow dot edge — matches stroke-dasharray gap (3 3) */
const DASH_GAP = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Whether a node renders as a hollow tip (stroke-only dot with gap) */
function isHollowTip(node: OverlayNode | undefined): boolean {
	if (!node) return false;
	const tip = node.isBranchTip || node.isWip;
	const hollow = node.isStash || node.isWip || node.isMerge;
	return tip && hollow;
}

// ─── Path builder ─────────────────────────────────────────────────────────────

function buildPath(
	conn: OverlayConnection,
	nodeByPos: Map<string, OverlayNode>,
	ctx: PathContext,
): OverlayPath {
	const { cx, cy, R, dotRadius } = ctx;

	const childNode = nodeByPos.get(`${conn.childX},${conn.childY}`);
	const parentNode = nodeByPos.get(`${conn.parentX},${conn.parentY}`);

	/** Direction of travel from the child row to the parent row */
	const rowSign = Math.sign(conn.parentY - conn.childY);
	const minRow = Math.min(conn.childY, conn.parentY);
	const maxRow = Math.max(conn.childY, conn.parentY);

	// Hollow tips pull their end of the path back to the ring's edge
	const childStartY = isHollowTip(childNode)
		? cy(conn.childY) + rowSign * (dotRadius + DASH_GAP)
		: cy(conn.childY);
	const parentEndY = isHollowTip(parentNode)
		? cy(conn.parentY) - rowSign * (dotRadius + DASH_GAP)
		: cy(conn.parentY);

	if (conn.childX === conn.parentX) {
		// ── Same column: vertical line ──
		const col = conn.childX;

		return {
			d: `M ${cx(col)} ${childStartY} V ${parentEndY}`,
			colorIndex: conn.colorIndex,
			dashed: conn.dashed,
			minRow,
			maxRow,
		};
	} else if (childNode?.isMerge) {
		// ── Merge: horizontal → bezier curve → vertical ──
		// Path: H from merge commit to parent's column, curve, V to parent
		const goingRight = conn.parentX > conn.childX;
		const hSign = goingRight ? 1 : -1;

		const startX = cx(conn.childX);
		const startY = cy(conn.childY);

		// Horizontal segment stops R before parent column
		const hTarget = cx(conn.parentX) - hSign * R;
		// Corner point: at parent column, R from the child row toward the parent
		const cornerX = cx(conn.parentX);
		const cornerY = cy(conn.childY) + rowSign * R;

		// Bezier control points for 90° quarter-circle
		const cp1x = cx(conn.parentX) - hSign * (1 - KAPPA) * R;
		const cp1y = cy(conn.childY);
		const cp2x = cx(conn.parentX);
		const cp2y = cy(conn.childY) + rowSign * KAPPA * R;

		const d = `M ${startX} ${startY} H ${hTarget} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${cornerX} ${cornerY} V ${parentEndY}`;

		return {
			d,
			colorIndex: conn.colorIndex,
			dashed: conn.dashed,
			minRow,
			maxRow,
		};
	} else {
		// ── Fork/normal: vertical → bezier curve → horizontal ──
		// Path: V along child's column to parent's row, curve, H to parent
		const goingRight = conn.parentX > conn.childX;
		const hSign = goingRight ? 1 : -1;

		// Vertical segment stops R short of parent row center
		const vTarget = cy(conn.parentY) - rowSign * R;
		// Corner point: where curve ends, at parent row center in child's column
		const cornerX = cx(conn.childX);
		const cornerY = cy(conn.parentY);
		// Horizontal end: parent position
		const endX = isHollowTip(parentNode)
			? cx(conn.parentX) - hSign * (dotRadius + DASH_GAP)
			: cx(conn.parentX);

		// Bezier control points for 90° quarter-circle
		const cp1x = cx(conn.childX);
		const cp1y = cornerY - rowSign * (1 - KAPPA) * R;
		const cp2x = cx(conn.childX) + hSign * KAPPA * R;
		const cp2y = cornerY;

		// After curve, horizontal target: R into the turn from child's column
		const hStart = cx(conn.childX) + hSign * R;

		const d = `M ${cornerX} ${childStartY} V ${vTarget} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${hStart} ${cornerY} H ${endX}`;

		return {
			d,
			colorIndex: conn.colorIndex,
			dashed: conn.dashed,
			minRow,
			maxRow,
		};
	}
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function buildOverlayPaths(
	data: OverlayGraphData,
	settings: GraphDisplaySettings = DEFAULT_GRAPH_SETTINGS,
): OverlayPath[] {
	const ctx = makePathContext(settings);
	const { connections, nodes } = data;

	// Build position→node map for O(1) lookups
	const nodeByPos = new Map<string, OverlayNode>();
	for (const node of nodes) {
		nodeByPos.set(`${node.x},${node.y}`, node);
	}

	const result: OverlayPath[] = [];
	for (const conn of connections) {
		result.push(buildPath(conn, nodeByPos, ctx));
	}
	return result;
}
