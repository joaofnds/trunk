import { buildTree, collectFilePaths } from "./build-tree.js";
import type { FileStatus } from "./types.js";

export type DiffTarget = { kind: "file"; path: string } | { kind: "empty" };

/**
 * Decide which file (if any) diff-in-view navigation should land on for a
 * newly-selected commit: the remembered path when the commit still touches
 * it, else the first file in the visible display order.
 */
export function resolveDiffTarget(
	remembered: string | null,
	paths: string[],
	treeViewEnabled: boolean,
): DiffTarget {
	if (paths.length === 0) return { kind: "empty" };

	if (remembered !== null && paths.includes(remembered)) {
		return { kind: "file", path: remembered };
	}

	const orderedPaths = treeViewEnabled
		? collectFilePaths(buildTree(paths.map(toMinimalFileStatus)))
		: paths;
	return { kind: "file", path: orderedPaths[0] };
}

function toMinimalFileStatus(path: string): FileStatus {
	return { path, status: "Modified", is_binary: false };
}
