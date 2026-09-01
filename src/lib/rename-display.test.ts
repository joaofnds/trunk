import { describe, expect, it } from "vitest";
import { renamePartsOf } from "./rename-display.js";

describe("renamePartsOf", () => {
	it("is null for a file that was not renamed", () => {
		expect(renamePartsOf("src/a.ts", null)).toBeNull();
	});

	// A rename inside one directory names that directory once and scopes the two
	// names to it, as `git show --stat` does. Writing the directory on only one
	// side would read as a move out of the root and into it.
	it("scopes the two names under the directory they share", () => {
		expect(renamePartsOf("code/math-util.ts", "code/util.ts")).toEqual({
			prefix: "code/",
			from: "util.ts",
			to: "math-util.ts",
		});
	});

	it("scopes them under a deep directory the same way", () => {
		expect(renamePartsOf("src/lib/deep/new.ts", "src/lib/deep/old.ts")).toEqual(
			{ prefix: "src/lib/deep/", from: "old.ts", to: "new.ts" },
		);
	});

	// A move is about the directories, so both paths stay whole and unscoped.
	it("keeps both paths whole when the file moved between directories", () => {
		expect(renamePartsOf("src/new/a.ts", "src/old/a.ts")).toEqual({
			prefix: "",
			from: "src/old/a.ts",
			to: "src/new/a.ts",
		});
	});

	it("keeps both paths whole when nothing is shared", () => {
		expect(renamePartsOf("lib/b.ts", "src/a.ts")).toEqual({
			prefix: "",
			from: "src/a.ts",
			to: "lib/b.ts",
		});
	});

	it("keeps both paths whole when a file moves to the root", () => {
		expect(renamePartsOf("a.ts", "src/a.ts")).toEqual({
			prefix: "",
			from: "src/a.ts",
			to: "a.ts",
		});
	});

	// "src/a.ts" and "src/alt/a.ts" share the characters "src/a" but sit in
	// different directories: this is a move, and both paths stay whole.
	it("compares whole directories, never a partial segment", () => {
		expect(renamePartsOf("src/alt/a.ts", "src/a.ts")).toEqual({
			prefix: "",
			from: "src/a.ts",
			to: "src/alt/a.ts",
		});
	});

	it("has no prefix to scope for a rename at the repository root", () => {
		expect(renamePartsOf("b.ts", "a.ts")).toEqual({
			prefix: "",
			from: "a.ts",
			to: "b.ts",
		});
	});
});
