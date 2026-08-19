import { describe, expect, it } from "vitest";
import { resolveDiffTarget } from "./diff-in-view.js";

describe("resolveDiffTarget", () => {
	it("keeps the remembered path when the new commit touches it", () => {
		const result = resolveDiffTarget("b.ts", ["a.ts", "b.ts"], false);

		expect(result).toEqual({ kind: "file", path: "b.ts" });
	});

	it("falls back to the first path in list order when the remembered path is absent", () => {
		const result = resolveDiffTarget("missing.ts", ["a.ts", "b.ts"], false);

		expect(result).toEqual({ kind: "file", path: "a.ts" });
	});

	it("falls back to the first path in tree order when tree view is enabled", () => {
		// Tree order sorts directories before files, so "src/a.ts" sorts ahead
		// of "b.ts" even though list order has "b.ts" first.
		const result = resolveDiffTarget("missing.ts", ["b.ts", "src/a.ts"], true);

		expect(result).toEqual({ kind: "file", path: "src/a.ts" });
	});

	it("returns empty for a commit with no files", () => {
		const result = resolveDiffTarget("b.ts", [], false);

		expect(result).toEqual({ kind: "empty" });
	});

	it("opens the first file when nothing is remembered yet", () => {
		const result = resolveDiffTarget(null, ["a.ts", "b.ts"], false);

		expect(result).toEqual({ kind: "file", path: "a.ts" });
	});
});
