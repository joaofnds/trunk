import { describe, expect, it } from "vitest";
import { repositoryName } from "./path.js";

describe("repositoryName", () => {
	it.each([
		["/Users/test/code/trunk", "trunk"],
		["/Users/test/code/trunk/", "trunk"],
		["/", "/"],
	])("names %s as %s", (path, name) => {
		expect(repositoryName(path)).toBe(name);
	});
});
