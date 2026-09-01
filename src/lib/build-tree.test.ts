import { describe, expect, it } from "vitest";
import { makeFile } from "../__tests__/helpers/factories.js";
import type { DirectoryNode, FileNode, TreeNode } from "./build-tree.js";
import {
	buildTree,
	collectFilePaths,
	countFiles,
	sumCommentsInSubtree,
} from "./build-tree.js";
import type { FileStatus } from "./types.js";

/** Extract names from a TreeNode[] for concise assertions */
function getNames(nodes: TreeNode[]): string[] {
	return nodes.map((n) => n.name);
}

/** Extract types from a TreeNode[] for concise assertions */
function getTypes(nodes: TreeNode[]): string[] {
	return nodes.map((n) => n.type);
}

describe("buildTree", () => {
	// --- Group: empty input ---
	describe("empty input", () => {
		it("returns empty array for empty input", () => {
			expect(buildTree([])).toEqual([]);
		});
	});

	// --- Group: single file at root ---
	describe("single file at root", () => {
		it("returns a single file node for root-level file", () => {
			const result = buildTree([makeFile("README.md")]);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("file");
			expect(result[0].name).toBe("README.md");
			expect(result[0].path).toBe("README.md");
			expect((result[0] as FileNode).file.path).toBe("README.md");
		});
	});

	// --- Group: single file in directory (no compression per D-05) ---
	describe("single file in directory (D-05: no compression when single child is file)", () => {
		it("wraps file in directory node without compression", () => {
			const result = buildTree([makeFile("src/index.ts")]);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("directory");
			expect(result[0].name).toBe("src");
			const dir = result[0] as DirectoryNode;
			expect(dir.children).toHaveLength(1);
			expect(dir.children[0].type).toBe("file");
			expect(dir.children[0].name).toBe("index.ts");
		});
	});

	// --- Group: path compression (D-04, TREE-07) ---
	describe("path compression (D-04)", () => {
		it("compresses single-child directory chains", () => {
			const result = buildTree([makeFile("src/lib/utils/helper.ts")]);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("directory");
			expect(result[0].name).toBe("src/lib/utils");
			expect((result[0] as DirectoryNode).path).toBe("src/lib/utils");
			const dir = result[0] as DirectoryNode;
			expect(dir.children).toHaveLength(1);
			expect(dir.children[0].type).toBe("file");
			expect(dir.children[0].name).toBe("helper.ts");
		});

		it("compresses deeply nested chains", () => {
			const result = buildTree([makeFile("a/b/c/d/e/f.ts")]);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("directory");
			expect(result[0].name).toBe("a/b/c/d/e");
		});

		it("stops compression when directory has multiple children", () => {
			const result = buildTree([
				makeFile("src/lib/a.ts"),
				makeFile("src/lib/b.ts"),
			]);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("directory");
			expect(result[0].name).toBe("src/lib");
			const dir = result[0] as DirectoryNode;
			expect(dir.children).toHaveLength(2);
			expect(getNames(dir.children)).toEqual(["a.ts", "b.ts"]);
		});

		it("stops compression at directory with mixed children", () => {
			const result = buildTree([
				makeFile("src/lib/utils/a.ts"),
				makeFile("src/lib/index.ts"),
			]);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("src/lib");
			const dir = result[0] as DirectoryNode;
			expect(dir.children).toHaveLength(2);
			// directory "utils" before file "index.ts"
			expect(getTypes(dir.children)).toEqual(["directory", "file"]);
			expect(dir.children[0].name).toBe("utils");
			expect(dir.children[1].name).toBe("index.ts");
		});
	});

	// --- Group: sorting (D-06, D-07) ---
	describe("sorting", () => {
		it("sorts directories before files (D-06)", () => {
			const result = buildTree([makeFile("zebra.ts"), makeFile("src/app.ts")]);
			expect(result[0].type).toBe("directory");
			expect(result[0].name).toBe("src");
			expect(result[1].type).toBe("file");
			expect(result[1].name).toBe("zebra.ts");
		});

		it("sorts alphabetically case-insensitive within type (D-07)", () => {
			const result = buildTree([
				makeFile("Banana.ts"),
				makeFile("apple.ts"),
				makeFile("cherry.ts"),
			]);
			expect(getNames(result)).toEqual(["apple.ts", "Banana.ts", "cherry.ts"]);
		});

		it("sorts directories alphabetically case-insensitive", () => {
			const result = buildTree([makeFile("Zoo/a.ts"), makeFile("alpha/b.ts")]);
			expect(getNames(result)).toEqual(["alpha", "Zoo"]);
		});

		it("sorts recursively at all levels", () => {
			const result = buildTree([
				makeFile("src/zebra.ts"),
				makeFile("src/utils/helper.ts"),
				makeFile("src/apple.ts"),
			]);
			const src = result[0] as DirectoryNode;
			// directory "utils" before files
			expect(getTypes(src.children)).toEqual(["directory", "file", "file"]);
			// files sorted: apple before zebra
			expect(src.children[1].name).toBe("apple.ts");
			expect(src.children[2].name).toBe("zebra.ts");
		});
	});

	// --- Group: directory path field (D-03) ---
	describe("directory path field (D-03)", () => {
		it("directory nodes carry full relative path for compressed dirs", () => {
			const result = buildTree([makeFile("src/lib/file.ts")]);
			const dir = result[0] as DirectoryNode;
			// Compressed: src/lib (single child is file, but src has one child dir "lib" that has one file)
			// Actually: src -> lib -> file.ts; src has 1 child (dir lib), lib has 1 child (file) => compress src/lib
			expect(dir.name).toBe("src/lib");
			expect(dir.path).toBe("src/lib");
		});

		it("root-level directory has its name as path", () => {
			const result = buildTree([makeFile("docs/readme.md")]);
			const dir = result[0] as DirectoryNode;
			expect(dir.path).toBe("docs");
		});
	});

	// --- Group: file node carries FileStatus (D-01) ---
	describe("file node carries FileStatus (D-01)", () => {
		it("file node carries original FileStatus", () => {
			const file: FileStatus = {
				path: "test.txt",
				old_path: null,
				status: "New",
				is_binary: true,
			};
			const result = buildTree([file]);
			expect(result).toHaveLength(1);
			const node = result[0] as FileNode;
			expect(node.type).toBe("file");
			expect(node.file).toBe(file); // same reference
			expect(node.file.status).toBe("New");
			expect(node.file.is_binary).toBe(true);
		});
	});

	// --- Group: multiple files same directory ---
	describe("multiple files same directory", () => {
		it("groups files under shared directory", () => {
			const result = buildTree([
				makeFile("src/c.ts"),
				makeFile("src/a.ts"),
				makeFile("src/b.ts"),
			]);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("src");
			const dir = result[0] as DirectoryNode;
			expect(dir.children).toHaveLength(3);
			expect(getNames(dir.children)).toEqual(["a.ts", "b.ts", "c.ts"]);
		});
	});

	// --- Group: mixed depths ---
	describe("mixed depths", () => {
		it("handles files at root and nested simultaneously", () => {
			const result = buildTree([
				makeFile("README.md"),
				makeFile("src/lib/utils.ts"),
				makeFile("package.json"),
			]);
			// directory "src" before files
			expect(getTypes(result)).toEqual(["directory", "file", "file"]);
			expect(result[0].name).toBe("src/lib");
			expect(result[1].name).toBe("package.json");
			expect(result[2].name).toBe("README.md");
		});
	});

	// --- Group: edge cases ---
	describe("edge cases", () => {
		it("handles unicode filenames", () => {
			const result = buildTree([
				makeFile("docs/日本語.md"),
				makeFile("docs/résumé.txt"),
			]);
			expect(result).toHaveLength(1);
			const dir = result[0] as DirectoryNode;
			expect(dir.children).toHaveLength(2);
			// Both files should exist; exact order depends on locale
			const names = getNames(dir.children);
			expect(names).toContain("日本語.md");
			expect(names).toContain("résumé.txt");
		});

		it("handles single-segment paths (root files only)", () => {
			const result = buildTree([makeFile("b.ts"), makeFile("a.ts")]);
			expect(result).toHaveLength(2);
			expect(getTypes(result)).toEqual(["file", "file"]);
			expect(getNames(result)).toEqual(["a.ts", "b.ts"]);
		});

		it("preserves different file statuses", () => {
			const result = buildTree([
				makeFile("a.ts", "New"),
				makeFile("b.ts", "Modified"),
				makeFile("c.ts", "Deleted"),
			]);
			expect(result).toHaveLength(3);
			expect((result[0] as FileNode).file.status).toBe("New");
			expect((result[1] as FileNode).file.status).toBe("Modified");
			expect((result[2] as FileNode).file.status).toBe("Deleted");
		});
	});
});

describe("countFiles", () => {
	it("returns 0 for empty array", () => {
		expect(countFiles([])).toBe(0);
	});

	it("counts files in deeply nested tree", () => {
		const tree = buildTree([
			makeFile("src/lib/utils/a.ts"),
			makeFile("src/lib/utils/b.ts"),
			makeFile("src/index.ts"),
			makeFile("README.md"),
		]);
		expect(countFiles(tree)).toBe(4);
	});
});

describe("collectFilePaths", () => {
	it("returns empty array for empty input", () => {
		expect(collectFilePaths([])).toEqual([]);
	});

	it("collects all file paths from tree with mixed dir/file at root", () => {
		const tree = buildTree([
			makeFile("src/a.ts"),
			makeFile("README.md"),
			makeFile("package.json"),
		]);
		const paths = collectFilePaths(tree);
		expect(paths).toHaveLength(3);
		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("README.md");
		expect(paths).toContain("package.json");
	});
});

describe("sumCommentsInSubtree", () => {
	it("returns 0 when no descendant has a comment", () => {
		const tree = buildTree([makeFile("src/a.ts"), makeFile("src/b.ts")]);
		expect(sumCommentsInSubtree(tree, new Map())).toBe(0);
	});

	it("rolls up counts across nested directories full-depth", () => {
		const tree = buildTree([
			makeFile("src/lib/a.ts"),
			makeFile("src/components/b.ts"),
			makeFile("README.md"),
		]);
		const counts = new Map([
			["src/lib/a.ts", 2],
			["src/components/b.ts", 3],
			["README.md", 1],
		]);
		expect(sumCommentsInSubtree(tree, counts)).toBe(6);
	});

	it("sums the whole subtree of a compressed single-child directory chain", () => {
		// src/lib/utils compresses into one directory node; its descendant file
		// still rolls up.
		const tree = buildTree([makeFile("src/lib/utils/helper.ts")]);
		const dir = tree[0];
		if (dir.type !== "directory") throw new Error("expected directory");
		const counts = new Map([["src/lib/utils/helper.ts", 4]]);
		expect(sumCommentsInSubtree(dir.children, counts)).toBe(4);
	});
});
