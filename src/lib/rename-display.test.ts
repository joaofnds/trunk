import { describe, expect, it } from "vitest";
import { renamePartsOf } from "./rename-display.js";

describe("renamePartsOf", () => {
	it("is null for a file that was not renamed", () => {
		expect(renamePartsOf("src/a.ts", null)).toBeNull();
	});

	// Both paths in full, including the directory they share: shortening either
	// side makes the two sides mean different things (TRUNK-88).
	it("keeps both paths whole when the file stayed in its directory", () => {
		expect(renamePartsOf("code/math-util.ts", "code/util.ts")).toEqual({
			from: "code/util.ts",
			to: "code/math-util.ts",
		});
	});

	it("keeps both paths whole when the file moved between directories", () => {
		expect(renamePartsOf("src/new/a.ts", "src/old/a.ts")).toEqual({
			from: "src/old/a.ts",
			to: "src/new/a.ts",
		});
	});

	it("keeps both paths whole at the repository root", () => {
		expect(renamePartsOf("b.ts", "a.ts")).toEqual({
			from: "a.ts",
			to: "b.ts",
		});
	});
});
