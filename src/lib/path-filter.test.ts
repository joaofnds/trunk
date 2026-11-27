import { describe, expect, it } from "vitest";
import { createPathFilter } from "./path-filter.js";

describe("changed path filtering", () => {
	const files = [
		{ path: "native/readme.md", old_path: null },
		{ path: "scripts/drive/native.ts", old_path: null },
		{ path: "src/New.ts", old_path: "scripts/old-native.ts" },
		{ path: "src/Native.test.ts", old_path: null },
	];
	const find = createPathFilter(files);

	it("retains input order and objects when no query is active", () => {
		expect(find("")).toBe(files);
		expect(find("   ")).toBe(files);
	});

	it("ranks basename matches before directory matches and marks the alignment", () => {
		const paths = [{ path: "panel/x" }, { path: "src/panel.ts" }];
		const rows = createPathFilter(paths)("pnl");

		expect(rows.map((row) => row.path)).toEqual(["src/panel.ts", "panel/x"]);
		expect(rows.map((row) => row.match?.path)).toEqual([
			[4, 6, 8],
			[0, 2, 4],
		]);
	});

	it("marks both names of a rename without duplicating its row", () => {
		const rename = { path: "src/current.ts", old_path: "src/old.ts" };
		const rows = createPathFilter([rename])("src");

		expect(rows).toEqual([
			{ ...rename, match: { path: [0, 1, 2], oldPath: [0, 1, 2] } },
		]);
		expect(find("old")[0].match).toEqual({ path: [], oldPath: [8, 9, 10] });
	});

	it("ranks equally strong matches by their rightmost alignment in the basename", () => {
		const find = createPathFilter([
			{ path: "panel/other.ts" },
			{ path: "panel/src/panel.ts" },
		]);

		const rows = find("panel");
		expect(rows.map((row) => row.path)).toEqual([
			"panel/src/panel.ts",
			"panel/other.ts",
		]);
		expect(rows[0].match?.path).toEqual([10, 11, 12, 13, 14]);
	});

	it("returns the same fuzzy alignment after other queries reuse the scratch space", () => {
		const find = createPathFilter([
			{ path: "docs/architecture/diff-virtualization.md" },
		]);
		const offsets = [20, 25];

		expect(find("fr")[0].match?.path).toEqual(offsets);
		find("ff");
		expect(find("fr")[0].match?.path).toEqual(offsets);
	});

	it.each([
		{ query: "^src", keep: "src/native.ts", reject: "app/src/native.ts" },
		{ query: ".ts$", keep: "src/native.ts", reject: "src/native.tsx" },
		{ query: "'native", keep: "src/native.ts", reject: "src/n_at_ive.ts" },
		{ query: "native !test", keep: "native.ts", reject: "native.test.ts" },
	])(
		"matches $keep and excludes $reject for $query",
		({ query, keep, reject }) => {
			const find = createPathFilter([{ path: reject }, { path: keep }]);
			expect(find(query).map((row) => row.path)).toEqual([keep]);
		},
	);

	it("requires every space-separated term to match", () => {
		const find = createPathFilter([
			{ path: "native.ts" },
			{ path: "src/panel.ts" },
			{ path: "src/native.ts" },
		]);
		expect(find("src native").map((row) => row.path)).toEqual([
			"src/native.ts",
		]);
	});

	it("ignores case until the query contains a capital letter", () => {
		const find = createPathFilter([
			{ path: "native.ts" },
			{ path: "Native.ts" },
		]);

		expect(find("native").map((row) => row.path)).toEqual([
			"native.ts",
			"Native.ts",
		]);
		expect(find("Native").map((row) => row.path)).toEqual(["Native.ts"]);
	});

	it("accepts either side of an alternative", () => {
		expect(
			find(".md$ | ^src/New")
				.map((row) => row.path)
				.sort(),
		).toEqual(["native/readme.md", "src/New.ts"]);
	});

	it("preserves input order for exclusions with no positive match", () => {
		const rows = find("!readme");

		expect(rows.map((row) => row.path)).toEqual(
			files.slice(1).map((row) => row.path),
		);
		expect(rows.every((row) => row.match?.path.length === 0)).toBe(true);
	});

	it("ranks rows admitted by an exclusion when the query has a positive alternative", () => {
		const find = createPathFilter(
			["a", "bbbb", "d/b", "b"].map((path) => ({ path })),
		);

		expect(find("a | !z").map((row) => row.path)).toEqual([
			"a",
			"b",
			"d/b",
			"bbbb",
		]);
		expect(find("missing | !z").map((row) => row.path)).toEqual([
			"a",
			"b",
			"d/b",
			"bbbb",
		]);
		expect(find("!z").map((row) => row.path)).toEqual([
			"a",
			"bbbb",
			"d/b",
			"b",
		]);
	});

	it("reports UTF-16 offsets in the displayed spelling, including decomposed accents", () => {
		const [row] = createPathFilter([{ path: "🎵/cafe\u0301.ts" }])("cafe");
		expect(row.match?.path).toEqual([3, 4, 5, 6, 7]);
	});

	it("keeps the original Unicode spelling in anchored queries and paths", () => {
		const find = createPathFilter([{ path: "é" }, { path: "e\u0301" }]);

		expect(find("^é$").map((row) => row.path)).toEqual(["é"]);
		expect(find("^e\u0301$").map((row) => row.path)).toEqual(["e\u0301"]);
	});

	it.each([
		{ query: "12", path: "１２.ts" },
		{ query: "B", path: "Ｂeta" },
		{ query: ".txt", path: "｡txt" },
		{ query: "{x}", path: "｛x｝" },
	])(
		"matches $query in fullwidth and halfwidth path $path",
		({ query, path }) => {
			const find = createPathFilter([{ path }]);
			expect(find(query).map((row) => row.path)).toEqual([path]);
		},
	);

	it("uses fzf's Latin normalization table in smart-case queries", () => {
		const find = createPathFilter([{ path: "Ā" }, { path: "À" }]);
		expect(find("A").map((row) => row.path)).toEqual(["À"]);
		expect(find("a").map((row) => row.path)).toEqual(["Ā", "À"]);
	});

	it("uses Unicode White_Space to trim anchored names and break length ties", () => {
		const find = createPathFilter([
			{ path: "x\u0085" },
			{ path: "x\ufeff" },
			{ path: "x" },
		]);
		expect(find("^x$").map((row) => row.path)).toEqual(["x\u0085", "x"]);
		expect(find("x").map((row) => row.path)).toEqual([
			"x\u0085",
			"x",
			"x\ufeff",
		]);
	});

	it("searches for literal spaces in paths with fzf escaping", () => {
		const rows = createPathFilter([
			{ path: "two words.txt" },
			{ path: "twowords.txt" },
		])("two\\ words");

		expect(rows.map((row) => row.path)).toEqual(["two words.txt"]);
	});

	it("preserves nonbreaking spaces and treats a tab like fzf's escaped space", () => {
		const find = createPathFilter([
			{ path: "a\u00a0" },
			{ path: "a b" },
			{ path: "a\tb" },
			{ path: "x" },
		]);
		expect(find("\u00a0").map((row) => row.path)).toEqual(["a\u00a0"]);
		expect(find("a\u00a0").map((row) => row.path)).toEqual(["a\u00a0"]);
		expect(find("\t").map((row) => row.path)).toEqual(["a b"]);
		expect(find("a\t").map((row) => row.path)).toEqual(["a b"]);
	});

	it("requires two word boundaries for fully quoted terms", () => {
		const find = createPathFilter([
			{ path: "dir/nativex-native.ts" },
			{ path: "dir/innative.ts" },
			{ path: "native.txt" },
			{ path: "dir/r_native_1.ts" },
			{ path: "src/native.ts" },
			{ path: "dir/nativeReader.ts" },
		]);

		const rows = find("'native'");
		expect(rows.map((row) => row.path)).toEqual([
			"src/native.ts",
			"native.txt",
			"dir/nativex-native.ts",
			"dir/r_native_1.ts",
		]);
		expect(rows[2].match?.path).toEqual([12, 13, 14, 15, 16, 17]);
		expect(find("!'native'").map((row) => row.path)).toEqual([
			"dir/innative.ts",
			"dir/nativeReader.ts",
		]);
	});

	it("prefers a path boundary to an earlier punctuation boundary", () => {
		const paths = ["a.native", "long/path/native", "native"].map((path) => ({
			path,
		}));
		expect(createPathFilter(paths)("native").map((row) => row.path)).toEqual([
			"native",
			"long/path/native",
			"a.native",
		]);
	});

	it("matches entire Unicode code points and returns their displayed code units", () => {
		const find = createPathFilter([{ path: "😁🨀/x" }, { path: "🎵/😀x" }]);
		const rows = find("😀x");
		expect(rows.map((row) => row.path)).toEqual(["🎵/😀x"]);
		expect(rows[0].match?.path).toEqual([3, 4, 5]);
	});

	it("matches the whole Unicode path between both anchors", () => {
		const path = "🎵café.ts";
		const find = createPathFilter([
			{ path: `src/${path}` },
			{ path },
			{ path: `${path}x` },
		]);

		const rows = find(`^${path}$`);
		expect(rows.map((row) => row.path)).toEqual([path]);
		expect(rows[0].match?.path).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
});
