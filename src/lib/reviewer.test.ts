import { describe, expect, it } from "vitest";
import { initials } from "./reviewer.svelte.js";

describe("initials", () => {
	it.each([
		{ name: "João Fernandes", expected: "JF" },
		{ name: "Ada Augusta King Lovelace", expected: "AL" },
		{ name: "ada", expected: "A" },
		{ name: "  grace   hopper  ", expected: "GH" },
		{ name: "Émile Zola", expected: "ÉZ" },
	])("sets $name as $expected", ({ name, expected }) => {
		expect(initials(name)).toBe(expected);
	});

	it("has none for a blank name", () => {
		expect(initials("   ")).toBeNull();
	});
});
