import type { OverlayNode, OverlayPath, OverlayRefPill } from "./types.js";

export interface VisibleOverlayElements {
	paths: OverlayPath[];
	dots: OverlayNode[];
	pills: OverlayRefPill[];
}

export function getVisibleOverlayElements(
	paths: OverlayPath[],
	nodes: OverlayNode[],
	startRow: number,
	endRow: number,
	pills: OverlayRefPill[] = [],
): VisibleOverlayElements {
	const visiblePaths: OverlayPath[] = [];

	for (const path of paths) {
		if (path.maxRow >= startRow && path.minRow <= endRow) {
			visiblePaths.push(path);
		}
	}

	const dots = nodes.filter((n) => n.y >= startRow && n.y <= endRow);
	const visiblePills = pills.filter(
		(p) => p.rowIndex >= startRow && p.rowIndex <= endRow,
	);

	return { paths: visiblePaths, dots, pills: visiblePills };
}
