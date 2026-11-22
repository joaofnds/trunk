import "../__tests__/helpers/tauri-mock";
import { describe, expect, it } from "vitest";
import { displayPath, repositoryName } from "./path.js";

describe("repositoryName", () => {
	it.each([
		["/Users/test/code/trunk", "trunk"],
		["/Users/test/code/trunk/", "trunk"],
		["/", "/"],
	])("names %s as %s", (path, name) => {
		expect(repositoryName(path)).toBe(name);
	});
});

describe("displayPath", () => {
	it.each([
		["/Users/test", "~/"],
		["/Users/test/code/trunk", "~/code/trunk"],
		["/Users/test-tools/code", "/Users/test-tools/code"],
	])("shows %s as %s", async (path, label) => {
		expect(await displayPath(path)).toBe(label);
	});
});
