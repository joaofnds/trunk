import { describe, expect, it } from "vitest";
import { renamePartsOf } from "./rename-display.js";

describe("renamePartsOf", () => {
	it("is null for a file that was not renamed", () => {
		expect(renamePartsOf("src/a.ts", null)).toBeNull();
	});

	// A rename inside one directory: the directory is not news, and dropping it
	// from the old side leaves the two names next to each other, which is the
	// comparison the row exists to make.
	it("drops the directory from the old side when the file did not move", () => {
		expect(renamePartsOf("code/math-util.ts", "code/util.ts")).toEqual({
			from: "util.ts",
			to: "code/math-util.ts",
		});
	});

	it("drops a deep directory the same way", () => {
		expect(renamePartsOf("src/lib/deep/new.ts", "src/lib/deep/old.ts")).toEqual(
			{ from: "old.ts", to: "src/lib/deep/new.ts" },
		);
	});

	// A move is about the directories, so hiding them would hide the change.
	it("keeps both paths whole when the file moved between directories", () => {
		expect(renamePartsOf("src/new/a.ts", "src/old/a.ts")).toEqual({
			from: "src/old/a.ts",
			to: "src/new/a.ts",
		});
	});

	it("keeps both paths whole when nothing is shared", () => {
		expect(renamePartsOf("lib/b.ts", "src/a.ts")).toEqual({
			from: "src/a.ts",
			to: "lib/b.ts",
		});
	});

	it("keeps both paths whole when a file moves to the root", () => {
		expect(renamePartsOf("a.ts", "src/a.ts")).toEqual({
			from: "src/a.ts",
			to: "a.ts",
		});
	});

	// "src/a.ts" and "src/alt/a.ts" share the characters "src/a" but sit in
	// different directories: this is a move, and both paths stay whole.
	it("compares whole directories, never a partial segment", () => {
		expect(renamePartsOf("src/alt/a.ts", "src/a.ts")).toEqual({
			from: "src/a.ts",
			to: "src/alt/a.ts",
		});
	});

	it("handles a rename at the repository root", () => {
		expect(renamePartsOf("b.ts", "a.ts")).toEqual({
			from: "a.ts",
			to: "b.ts",
		});
	});
});
