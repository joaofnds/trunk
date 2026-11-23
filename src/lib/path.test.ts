import "../__tests__/helpers/tauri-mock";
import { homeDir } from "@tauri-apps/api/path";
import { describe, expect, it, vi } from "vitest";
import { displayPath, repositoryName } from "./path.js";

describe("repositoryName", () => {
	it.each([
		["/Users/test/code/trunk", "trunk"],
		["/Users/test/code/trunk/", "trunk"],
		["C:\\projects\\trunk\\", "trunk"],
		["\\\\server\\team\\trunk", "trunk"],
		["/projects/back\\slash", "back\\slash"],
		["/", "/"],
	])("names %s as %s", (path, name) => {
		expect(repositoryName(path)).toBe(name);
	});
});

describe("displayPath", () => {
	it.each([
		["C:\\Users\\test\\", "C:\\Users\\test\\code\\trunk", "~\\code\\trunk"],
		["\\\\home\\team", "\\\\home\\team\\trunk", "~\\trunk"],
		[
			"C:\\Users\\test",
			"C:\\Users\\test-tools\\code",
			"C:\\Users\\test-tools\\code",
		],
	])(
		"abbreviates paths under %s at a directory boundary",
		async (home, path, label) => {
			vi.resetModules();
			vi.mocked(homeDir).mockResolvedValueOnce(home);
			const { displayPath } = await import("./path.js");
			expect(await displayPath(path)).toBe(label);
		},
	);

	it.each([
		["/Users/test", "~/"],
		["/Users/test/code/trunk", "~/code/trunk"],
		["/Users/test-tools/code", "/Users/test-tools/code"],
	])("shows %s as %s", async (path, label) => {
		expect(await displayPath(path)).toBe(label);
	});
});
