import { decodeGitName, filePathText, splitFilePath } from "./file-path.js";
import { fileKey, pathKey } from "./file-status.js";
import type { FilteredFile } from "./path-filter.js";
import { sumTallies } from "./review-filter.js";
import type { ReviewTally } from "./types.js";

export interface DirectoryNode {
	type: "directory";
	name: string; // Display name, may be compressed ("src/lib")
	path: string; // Full relative path prefix ("src/lib")
	children: TreeNode[];
	positions?: number[];
}

export interface FileNode {
	type: "file";
	name: string; // Filename only ("App.svelte")
	path: string; // Full relative path ("src/App.svelte")
	file: FilteredFile; // Original FileStatus for downstream rendering
}

export type TreeNode = DirectoryNode | FileNode;

function directoryMatches(file: FilteredFile, directory: string) {
	const match = file.match;
	if (
		!match?.oldPath.length ||
		!file.old_path ||
		splitFilePath(filePathText(file.old_path, file.old_path_bytes))
			.directory !== directory
	)
		return match?.path;

	return [...match.path, ...match.oldPath].sort((a, b) => a - b);
}

/** Insert files in input order so each directory inherits the rank of its
 *  first matching descendant. Unfiltered trees use the normal alphabetical
 *  directory-first order. */
export function buildTree(files: FilteredFile[]): TreeNode[] {
	const roots: TreeNode[] = [];
	const directories = new Map<string, DirectoryNode>();
	const matched = new Map<DirectoryNode, Set<number>>();

	for (const file of files) {
		const { directory, name } = splitFilePath(
			filePathText(file.path, file.path_bytes),
		);
		const segments = directory ? directory.split("/") : [];
		const rawSegments = file.path_bytes ? file.path.split("/") : segments;
		const positions = directoryMatches(file, directory);
		let labelStart = 0;
		let children = roots;
		let byteStart = 0;
		let cursor = 0;
		let prefix = "";
		for (const [index, label] of segments.entries()) {
			const segment = rawSegments[index];
			prefix = prefix ? `${prefix}/${segment}` : segment;
			let key = prefix;
			if (file.path_bytes) {
				const end = file.path_bytes.indexOf(47, byteStart);
				const rawPrefix = file.path_bytes.slice(0, end);
				key = decodeGitName(rawPrefix) ?? pathKey(prefix, rawPrefix);
				byteStart = end + 1;
			}

			let node = directories.get(key);
			if (!node) {
				node = { type: "directory", name: label, path: key, children: [] };
				directories.set(key, node);
				children.push(node);
			}
			children = node.children;

			const labelEnd = labelStart + label.length;
			if (positions && positions[cursor] <= labelEnd) {
				const hits = matched.get(node) ?? new Set<number>();
				while (positions[cursor] <= labelEnd) {
					hits.add(positions[cursor++] - labelStart);
				}
				matched.set(node, hits);
			}
			labelStart = labelEnd + 1;
		}
		children.push({ type: "file", name, path: fileKey(file), file });
	}

	finishTree(roots, files[0]?.match !== undefined, matched);
	return roots;
}

function finishTree(
	nodes: TreeNode[],
	ranked: boolean,
	matched: Map<DirectoryNode, Set<number>>,
): void {
	for (const node of nodes) {
		if (node.type === "file") continue;

		const positions: number[] = [];
		let part = node;
		let start = 0;
		for (;;) {
			const single = part.children.length === 1 ? part.children[0] : undefined;
			const next = single?.type === "directory" ? single : undefined;
			const hits = matched.get(part);
			if (hits) for (const pos of hits) positions.push(start + pos);
			if (!next) {
				if (hits?.has(part.name.length)) node.name += "/";
				break;
			}

			start = node.name.length + 1;
			node.name += `/${next.name}`;
			node.path = next.path;
			node.children = next.children;
			part = next;
		}
		if (positions.length) node.positions = positions.sort((a, b) => a - b);
		finishTree(node.children, ranked, matched);
	}

	if (!ranked) sortNodes(nodes);
}

/**
 * Sort nodes: directories before files (D-06),
 * alphabetically case-insensitive within each group (D-07).
 */
function sortNodes(nodes: TreeNode[]): void {
	nodes.sort((a, b) => {
		if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
}

/**
 * Count the total number of files (recursively) within a tree node array.
 * Counts only file nodes, not directory nodes.
 */
export function countFiles(nodes: TreeNode[]): number {
	let count = 0;
	for (const node of nodes) {
		if (node.type === "file") {
			count++;
		} else {
			count += countFiles(node.children);
		}
	}
	return count;
}

/**
 * Sum review-comment counts across all file descendants of a tree node array.
 * Mirrors countFiles, but reads each file's count from a `path → count` map
 * instead of counting 1 per file. Used to roll a collapsed directory's badge
 * up from its descendants.
 */
export function sumCommentsInSubtree(
	nodes: TreeNode[],
	perFileCounts: Map<string, number>,
): number {
	let sum = 0;
	for (const node of nodes) {
		if (node.type === "file") {
			sum += perFileCounts.get(node.path) ?? 0;
		} else {
			sum += sumCommentsInSubtree(node.children, perFileCounts);
		}
	}
	return sum;
}

/** Roll up the count by state alongside a collapsed directory's count. */
export function tallyInSubtree(
	nodes: TreeNode[],
	perFileTallies: Map<string, ReviewTally>,
): ReviewTally {
	let tally: ReviewTally = {};
	for (const node of nodes) {
		const childTally =
			node.type === "file"
				? perFileTallies.get(node.path)
				: tallyInSubtree(node.children, perFileTallies);
		tally = sumTallies(tally, childTally);
	}
	return tally;
}

/**
 * Collect all file paths recursively from a tree node array.
 */
export function collectFilePaths(nodes: TreeNode[]): string[] {
	const paths: string[] = [];
	for (const node of nodes) {
		if (node.type === "file") {
			paths.push(node.path);
		} else {
			paths.push(...collectFilePaths(node.children));
		}
	}
	return paths;
}
