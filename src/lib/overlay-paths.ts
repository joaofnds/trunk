import { DASH, DEFAULT_GRAPH_SETTINGS } from "./graph-constants.js";
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

/** Gap between path end and hollow dot edge, one gap of the dashed strokes */
const DASH_GAP = DASH;

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

// ─── WIP marker ───────────────────────────────────────────────────────────────

/**
 * The WIP marker's dashed ring as one arc per dash, laid out the way
 * `stroke-dasharray` lays dashes on a circle: from its rightmost point,
 * clockwise. A dashed circle would leave the dashes to the platform's own
 * measure of the curve, which differs between platforms by enough to move
 * them a pixel, as CI's runner did.
 */
export function wipMarkerPath(cx: number, cy: number, r: number): string {
	const circumference = 2 * Math.PI * r;
	const dashes: [number, number][] = [];
	for (let from = 0; from < circumference; from += 2 * DASH) {
		dashes.push([from, Math.min(from + DASH, circumference)]);
	}

	const first = dashes[0];
	const last = dashes[dashes.length - 1];
	if (last[1] === circumference) {
		dashes.shift();
		last[1] = circumference + first[1];
	}

	return dashes.map(([from, to]) => ringArc(cx, cy, r, from, to)).join(" ");
}

/** A clockwise arc of the ring between two distances along it from its rightmost point. */
function ringArc(
	cx: number,
	cy: number,
	r: number,
	from: number,
	to: number,
): string {
	const largeArc = to - from > Math.PI * r ? 1 : 0;
	return `M ${ringPoint(cx, cy, r, from)} A ${r} ${r} 0 ${largeArc} 1 ${ringPoint(cx, cy, r, to)}`;
}

/**
 * The point a distance along the ring from its rightmost point, clockwise, to a
 * thousandth of a pixel. The render goldens hold these coordinates, and the last
 * digits of `Math.cos` and `Math.sin` differ between JavaScript runtimes.
 */
function ringPoint(cx: number, cy: number, r: number, along: number): string {
	const x = cx + r * Math.cos(along / r);
	const y = cy + r * Math.sin(along / r);
	return `${Math.round(x * 1000) / 1000} ${Math.round(y * 1000) / 1000}`;
}
