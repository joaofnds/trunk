import { combineReviewTone } from "./review-filter.js";
import type { FileStatus, ReviewTone } from "./types.js";

export interface DirectoryNode {
	type: "directory";
	name: string; // Display name, may be compressed ("src/lib")
	path: string; // Full relative path prefix ("src/lib")
	children: TreeNode[];
}

export interface FileNode {
	type: "file";
	name: string; // Filename only ("App.svelte")
	path: string; // Full relative path ("src/App.svelte")
	file: FileStatus; // Original FileStatus for downstream rendering
}

export type TreeNode = DirectoryNode | FileNode;

/** Intermediate trie node used during tree construction. */
interface IntermediateDir {
	children: Map<string, IntermediateDir>;
	files: FileStatus[];
	path: string;
}

/**
 * Transform a flat array of FileStatus into a nested TreeNode[] tree.
 *
 * - Single-child directory chains are compressed (e.g. src/lib/utils becomes one node)
 * - A directory with exactly one child that is a file is NOT compressed
 * - Directories sort before files at every level
 * - Items within each group sort alphabetically case-insensitive
 * - Does not mutate the input array
 */
export function buildTree(files: FileStatus[]): TreeNode[] {
	if (files.length === 0) return [];

	// Phase 1: Build intermediate trie
	const root: IntermediateDir = { children: new Map(), files: [], path: "" };

	for (const file of files) {
		const segments = file.path.split("/");
		let current = root;

		// Walk directory segments (all but last, which is the filename)
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i];
			let child = current.children.get(seg);
			if (!child) {
				child = {
					children: new Map(),
					files: [],
					path: segments.slice(0, i + 1).join("/"),
				};
				current.children.set(seg, child);
			}
			current = child;
		}

		// Push file into the deepest directory
		current.files.push(file);
	}

	// Phase 2: Convert trie to TreeNode[]
	return convert(root);
}

/** Recursively convert an IntermediateDir into sorted TreeNode[]. */
function convert(dir: IntermediateDir): TreeNode[] {
	const result: TreeNode[] = [];

	// Convert subdirectories
	for (const [name, child] of dir.children) {
		const dirNode: DirectoryNode = {
			type: "directory",
			name,
			path: child.path,
			children: convert(child),
		};
		result.push(compress(dirNode));
	}

	// Convert files
	for (const file of dir.files) {
		const parts = file.path.split("/");
		const filename = parts[parts.length - 1];
		result.push({
			type: "file",
			name: filename,
			path: file.path,
			file,
		});
	}

	return sortNodes(result);
}

/**
 * Compress single-child directory chains into combined names.
 * Only compresses when the single child is another directory (D-05:
 * a directory with exactly one child that is a file is NOT compressed).
 */
function compress(node: DirectoryNode): DirectoryNode {
	while (node.children.length === 1 && node.children[0].type === "directory") {
		const child = node.children[0] as DirectoryNode;
		node = {
			type: "directory",
			name: `${node.name}/${child.name}`,
			path: child.path,
			children: child.children,
		};
	}
	return node;
}

/**
 * Sort nodes: directories before files (D-06),
 * alphabetically case-insensitive within each group (D-07).
 */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
	return nodes.sort((a, b) => {
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

/** Roll up the semantic tone alongside a collapsed directory's count. */
export function toneInSubtree(
	nodes: TreeNode[],
	perFileTones: Map<string, ReviewTone>,
): ReviewTone | null {
	let tone: ReviewTone | null = null;
	for (const node of nodes) {
		const childTone =
			node.type === "file"
				? (perFileTones.get(node.path) ?? null)
				: toneInSubtree(node.children, perFileTones);
		tone = combineReviewTone(tone, childTone);
	}
	return tone;
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
