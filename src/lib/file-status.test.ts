import { describe, expect, it } from "vitest";
import {
	fileStatusOf,
	patchLoadedDiff,
	toFileStatusList,
} from "./file-status.js";
import type { FileDiff } from "./types.js";

function fd(path: string, status: FileDiff["status"] = "Modified"): FileDiff {
	return { path, old_path: null, status, is_binary: false, hunks: [] };
}

describe("toFileStatusList", () => {
	it("maps git2 delta statuses onto the staging vocabulary", () => {
		const list = toFileStatusList([
			fd("a.ts", "Added"),
			fd("b.ts", "Deleted"),
			fd("c.ts", "Copied"),
		]);
		expect(list.map((f) => f.status)).toEqual(["New", "Deleted", "Modified"]);
	});

	it("falls back to Modified for a status it does not know", () => {
		const list = toFileStatusList([fd("a.ts", "Typechange" as never)]);
		expect(list[0].status).toBe("Modified");
	});

	it("carries a rename's old path through to the file list", () => {
		const renamed: FileDiff = {
			...fd("math-util.ts", "Renamed"),
			old_path: "util.ts",
		};
		expect(toFileStatusList([renamed])[0]).toEqual({
			path: "math-util.ts",
			old_path: "util.ts",
			status: "Renamed",
			is_binary: false,
		});
	});

	it("leaves old_path null for a file that was not renamed", () => {
		expect(toFileStatusList([fd("a.ts")])[0].old_path).toBeNull();
	});
});

describe("patchLoadedDiff", () => {
	it("replaces only the loaded entry", () => {
		const loaded: FileDiff = {
			...fd("a.ts"),
			hunks: [
				{
					header: "@@",
					old_start: 1,
					old_lines: 1,
					new_start: 1,
					new_lines: 1,
					lines: [],
				},
			],
		};
		const out = patchLoadedDiff([fd("a.ts"), fd("b.ts")], "a.ts", [loaded]);
		expect(out[0]).toBe(loaded);
		expect(out[1].path).toBe("b.ts");
	});

	it("keeps the entry when the load came back empty", () => {
		const list = [fd("a.ts")];
		expect(patchLoadedDiff(list, "a.ts", [])).toEqual(list);
	});
});

describe("fileStatusOf", () => {
	it("maps one git2 delta status onto the staging vocabulary", () => {
		expect(fileStatusOf("Added")).toBe("New");
		expect(fileStatusOf("Untracked")).toBe("New");
		expect(fileStatusOf("Renamed")).toBe("Renamed");
	});

	it("falls back to Modified for a status it does not know", () => {
		expect(fileStatusOf("Typechange" as never)).toBe("Modified");
	});
});
