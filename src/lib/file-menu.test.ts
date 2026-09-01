import { describe, expect, it } from "vitest";
import { pathMenuEntriesOf } from "./file-menu.js";

const REPO = "/repo";

describe("pathMenuEntriesOf", () => {
	it("offers the file's two paths when it was not renamed", () => {
		expect(pathMenuEntriesOf(REPO, "src/a.ts", null)).toEqual([
			{ text: "Copy Relative Path", value: "src/a.ts" },
			{ text: "Copy Absolute Path", value: "/repo/src/a.ts" },
		]);
	});

	// The row names two files, so a menu offering one silently picks for the
	// user — and it picked the new path, which is the one they can already read
	// off the row's right-hand side.
	it("names each side when the file was renamed", () => {
		expect(
			pathMenuEntriesOf(REPO, "code/math-util.ts", "code/util.ts"),
		).toEqual([
			{ text: "Copy Relative Path", value: "code/math-util.ts" },
			{ text: "Copy Absolute Path", value: "/repo/code/math-util.ts" },
			{ text: "Copy Old Relative Path", value: "code/util.ts" },
			{ text: "Copy Old Absolute Path", value: "/repo/code/util.ts" },
		]);
	});
});
