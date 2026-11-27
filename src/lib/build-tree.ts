import { splitFilePath } from "./file-path.js";
import { fileKey, pathKey } from "./file-status.js";
import { sumTallies } from "./review-filter.js";
import type { FileStatus, ReviewTally } from "./types.js";

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
	name: string;
	children: Map<string, IntermediateDir>;
	files: FileNode[];
	path: string;
}

const gitNameDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});
function decodeGitName(bytes: number[]): string | undefined {
	try {
		return gitNameDecoder.decode(Uint8Array.from(bytes));
	} catch {
		return undefined;
	}
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
	const root: IntermediateDir = {
		name: "",
		children: new Map(),
		files: [],
		path: "",
	};

	for (const file of files) {
		const { directory, name } = splitFilePath(file.path);
		let current = root;
		let start = 0;
		let prefix = "";
		for (const segment of directory ? directory.split("/") : []) {
			prefix = prefix ? `${prefix}/${segment}` : segment;
			let key = prefix;
			let label = segment;
			if (file.path_bytes) {
				const end = file.path_bytes.indexOf(47, start);
				const rawPrefix = file.path_bytes.slice(0, end);
				const textPrefix = decodeGitName(rawPrefix);
				key = textPrefix ?? pathKey(prefix, rawPrefix);
				label = decodeGitName(file.path_bytes.slice(start, end)) ?? segment;
				start = end + 1;
			}
			let child = current.children.get(key);
			if (!child) {
				child = {
					children: new Map(),
					files: [],
					name: label,
					path: key,
				};
				current.children.set(key, child);
			}
			current = child;
		}
		current.files.push({ type: "file", name, path: fileKey(file), file });
	}

	// Phase 2: Convert trie to TreeNode[]
	return convert(root);
}

/** Recursively convert an IntermediateDir into sorted TreeNode[]. */
function convert(dir: IntermediateDir): TreeNode[] {
	const result: TreeNode[] = [];

	// Convert subdirectories
	for (const child of dir.children.values()) {
		const dirNode: DirectoryNode = {
			type: "directory",
			name: child.name,
			path: child.path,
			children: convert(child),
		};
		result.push(compress(dirNode));
	}

	return sortNodes(result.concat(dir.files));
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
