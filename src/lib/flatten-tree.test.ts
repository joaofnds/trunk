import { describe, expect, it } from "vitest";
import { makeFile } from "../__tests__/helpers/factories.js";
import type { DirectoryNode, FileNode } from "./build-tree.js";
import { buildTree } from "./build-tree.js";
import type { FlatDirRow, FlatFileRow, FlatRow } from "./flatten-tree.js";
import {
	collectDirPaths,
	findFocusIndex,
	flattenTree,
	migrateExpanded,
} from "./flatten-tree.js";

describe("flattenTree", () => {
	describe("empty input", () => {
		it("returns empty array for empty nodes", () => {
			expect(flattenTree([], new Set())).toEqual([]);
		});
	});

	describe("single file at root", () => {
		it("returns a single file row at depth 0 with parentPath null", () => {
			const fileNode: FileNode = {
				type: "file",
				name: "README.md",
				path: "README.md",
				file: makeFile("README.md"),
			};
			const result = flattenTree([fileNode], new Set());
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("file");
			expect(result[0].depth).toBe(0);
			expect(result[0].parentPath).toBeNull();
			expect((result[0] as FlatFileRow).node).toBe(fileNode);
		});
	});

	describe("collapsed directory", () => {
		it("returns only the directory row when not in expanded set", () => {
			const tree = buildTree([makeFile("src/a.ts"), makeFile("src/b.ts")]);
			const result = flattenTree(tree, new Set());
			// Only the directory "src" should appear, not the children
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe("directory");
			expect((result[0] as FlatDirRow).expanded).toBe(false);
			expect(result[0].depth).toBe(0);
			expect(result[0].parentPath).toBeNull();
		});
	});

	describe("expanded directory", () => {
		it("includes every file in a directory wider than the argument limit", () => {
			const file: FileNode = {
				type: "file",
				name: "file.ts",
				path: "src/file.ts",
				file: makeFile("src/file.ts"),
			};
			const children = Array<FileNode>(150_000).fill(file);
			const directory: DirectoryNode = {
				type: "directory",
				name: "src",
				path: "src",
				children,
			};

			const rows = flattenTree([directory], new Set(["src"]));

			expect(rows).toHaveLength(children.length + 1);
			expect(rows.at(-1)?.node).toBe(file);
		});

		it("returns directory row followed by children at depth+1", () => {
			const tree = buildTree([makeFile("src/a.ts"), makeFile("src/b.ts")]);
			// "src" directory has path "src"
			const result = flattenTree(tree, new Set(["src"]));
			// Directory + 2 files
			expect(result).toHaveLength(3);
			expect(result[0].type).toBe("directory");
			expect((result[0] as FlatDirRow).expanded).toBe(true);
			expect(result[0].depth).toBe(0);
			expect(result[0].parentPath).toBeNull();
			// Children at depth 1
			expect(result[1].type).toBe("file");
			expect(result[1].depth).toBe(1);
			expect(result[1].parentPath).toBe("src");
			expect(result[2].type).toBe("file");
			expect(result[2].depth).toBe(1);
			expect(result[2].parentPath).toBe("src");
		});
	});

	describe("nested expansion", () => {
		it("produces correct incrementing depths for nested expanded directories", () => {
			// Build tree: src/lib/utils/helper.ts + src/lib/utils/other.ts
			// buildTree compresses single-child dir chains, so src/lib/utils becomes one node
			const tree = buildTree([
				makeFile("src/lib/utils/helper.ts"),
				makeFile("src/lib/utils/other.ts"),
			]);
			// Tree: [{ type: 'directory', name: 'src/lib/utils', path: 'src/lib/utils', children: [...] }]
			const result = flattenTree(tree, new Set(["src/lib/utils"]));
			// dir(src/lib/utils) at depth 0, helper.ts at depth 1, other.ts at depth 1
			expect(result).toHaveLength(3);
			expect(result[0].type).toBe("directory");
			expect(result[0].depth).toBe(0);
			expect(result[0].parentPath).toBeNull();
			expect(result[1].depth).toBe(1);
			expect(result[1].parentPath).toBe("src/lib/utils");
			expect(result[2].depth).toBe(1);
			expect(result[2].parentPath).toBe("src/lib/utils");
		});

		it("handles multiple levels of nesting with correct depths", () => {
			// Manually build a tree to test 3 levels of nesting
			const innerFile: FileNode = {
				type: "file",
				name: "deep.ts",
				path: "a/b/deep.ts",
				file: makeFile("a/b/deep.ts"),
			};
			const dirB: DirectoryNode = {
				type: "directory",
				name: "b",
				path: "a/b",
				children: [innerFile],
			};
			const dirA: DirectoryNode = {
				type: "directory",
				name: "a",
				path: "a",
				children: [dirB],
			};
			const result = flattenTree([dirA], new Set(["a", "a/b"]));
			// a(depth 0) -> b(depth 1) -> deep.ts(depth 2)
			expect(result).toHaveLength(3);
			expect(result[0].type).toBe("directory");
			expect(result[0].depth).toBe(0);
			expect(result[0].parentPath).toBeNull();
			expect(result[1].type).toBe("directory");
			expect(result[1].depth).toBe(1);
			expect(result[1].parentPath).toBe("a");
			expect(result[2].type).toBe("file");
			expect(result[2].depth).toBe(2);
			expect(result[2].parentPath).toBe("a/b");
		});
	});

	describe("partially expanded", () => {
		it("hides children of collapsed nested directory", () => {
			const innerFile: FileNode = {
				type: "file",
				name: "deep.ts",
				path: "a/b/deep.ts",
				file: makeFile("a/b/deep.ts"),
			};
			const dirB: DirectoryNode = {
				type: "directory",
				name: "b",
				path: "a/b",
				children: [innerFile],
			};
			const dirA: DirectoryNode = {
				type: "directory",
				name: "a",
				path: "a",
				children: [dirB],
			};
			// Only expand 'a', not 'a/b'
			const result = flattenTree([dirA], new Set(["a"]));
			expect(result).toHaveLength(2);
			expect(result[0].type).toBe("directory");
			expect((result[0] as FlatDirRow).expanded).toBe(true);
			expect(result[0].depth).toBe(0);
			expect(result[1].type).toBe("directory");
			expect((result[1] as FlatDirRow).expanded).toBe(false);
			expect(result[1].depth).toBe(1);
			expect(result[1].parentPath).toBe("a");
		});
	});

	describe("preserves sort order from buildTree", () => {
		it("directories appear before files within each level", () => {
			const tree = buildTree([
				makeFile("src/zebra.ts"),
				makeFile("src/utils/helper.ts"),
				makeFile("src/apple.ts"),
			]);
			// tree: [src] with children: [utils(dir), apple.ts, zebra.ts]
			const result = flattenTree(tree, new Set(["src"]));
			expect(result).toHaveLength(4);
			// First is the src dir, then utils(dir), then apple, then zebra
			expect(result[0].type).toBe("directory"); // src
			expect(result[1].type).toBe("directory"); // utils
			expect(result[2].type).toBe("file"); // apple.ts
			expect(result[3].type).toBe("file"); // zebra.ts
		});
	});
});

describe("findFocusIndex", () => {
	it("returns 0 for empty array", () => {
		expect(findFocusIndex([], "any")).toBe(0);
	});

	it("returns correct index for matching file path", () => {
		const fileA: FileNode = {
			type: "file",
			name: "a.ts",
			path: "a.ts",
			file: makeFile("a.ts"),
		};
		const fileB: FileNode = {
			type: "file",
			name: "b.ts",
			path: "b.ts",
			file: makeFile("b.ts"),
		};
		const rows: FlatRow[] = [
			{ type: "file", depth: 0, node: fileA, parentPath: null },
			{ type: "file", depth: 0, node: fileB, parentPath: null },
		];
		expect(findFocusIndex(rows, "b.ts")).toBe(1);
	});

	it("returns correct index for matching directory path", () => {
		const dir: DirectoryNode = {
			type: "directory",
			name: "src",
			path: "src",
			children: [],
		};
		const fileA: FileNode = {
			type: "file",
			name: "a.ts",
			path: "a.ts",
			file: makeFile("a.ts"),
		};
		const rows: FlatRow[] = [
			{
				type: "directory",
				depth: 0,
				node: dir,
				expanded: true,
				parentPath: null,
			},
			{ type: "file", depth: 0, node: fileA, parentPath: null },
		];
		expect(findFocusIndex(rows, "src")).toBe(0);
	});

	it("returns 0 when path not found", () => {
		const fileA: FileNode = {
			type: "file",
			name: "a.ts",
			path: "a.ts",
			file: makeFile("a.ts"),
		};
		const rows: FlatRow[] = [
			{ type: "file", depth: 0, node: fileA, parentPath: null },
		];
		expect(findFocusIndex(rows, "nonexistent.ts")).toBe(0);
	});
});

describe("collectDirPaths", () => {
	it("returns empty set for empty input", () => {
		expect(collectDirPaths([])).toEqual(new Set());
	});

	it("returns all directory paths from a tree", () => {
		const tree = buildTree([
			makeFile("src/lib/a.ts"),
			makeFile("src/lib/b.ts"),
			makeFile("docs/readme.md"),
		]);
		const paths = collectDirPaths(tree);
		expect(paths.has("src/lib")).toBe(true);
		expect(paths.has("docs")).toBe(true);
	});

	it("does not include file paths", () => {
		const tree = buildTree([makeFile("a.ts")]);
		const paths = collectDirPaths(tree);
		expect(paths.size).toBe(0);
	});
});

describe("migrateExpanded", () => {
	it("returns null when no migration needed", () => {
		const expanded = new Set(["src"]);
		const dirPaths = new Set(["src", "docs"]);
		const result = migrateExpanded(expanded, dirPaths);
		expect(result).toBeNull();
	});

	it("returns empty set for empty old set", () => {
		const expanded = new Set<string>();
		const dirPaths = new Set(["src", "docs"]);
		const result = migrateExpanded(expanded, dirPaths);
		// Empty set has nothing to migrate, so no change needed
		expect(result).toBeNull();
	});

	it("migrates compressed directory path", () => {
		// Old tree had "src", new tree compressed to "src/lib"
		const expanded = new Set(["src"]);
		const dirPaths = new Set(["src/lib"]);
		const result = migrateExpanded(expanded, dirPaths);
		expect(result).not.toBeNull();
		expect(result?.has("src/lib")).toBe(true);
		expect(result?.has("src")).toBe(false);
	});
});
