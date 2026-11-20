import { describe, expect, it } from "vitest";
import { graphKeyTarget, isGraphKey } from "./graph-keys.js";

describe("graphKeyTarget", () => {
	it.each([
		["ArrowDown", 3, 4],
		["ArrowUp", 3, 2],
		["PageDown", 3, 13],
		["PageUp", 13, 3],
		["Home", 30, 0],
		["End", 3, 99],
	] as const)("moves %s from row %i to row %i", (key, from, to) => {
		expect(graphKeyTarget(key, from, 100, 10)).toBe(to);
	});

	it.each([
		["PageDown", 95, 99],
		["PageUp", 4, 0],
	] as const)("stops %s at the end of the list", (key, from, to) => {
		expect(graphKeyTarget(key, from, 100, 10)).toBe(to);
	});

	it.each([
		["ArrowDown", 99],
		["PageDown", 99],
		["End", 99],
		["ArrowUp", 0],
		["PageUp", 0],
		["Home", 0],
	] as const)(
		"leaves the selection when %s has nowhere to go from row %i",
		(key, from) => {
			expect(graphKeyTarget(key, from, 100, 10)).toBeNull();
		},
	);

	it("starts from the first row when no loaded row is selected", () => {
		expect(graphKeyTarget("ArrowDown", -1, 100, 10)).toBe(0);
		expect(graphKeyTarget("PageDown", -1, 100, 10)).toBe(10);
		expect(graphKeyTarget("End", -1, 100, 10)).toBe(99);
		expect(graphKeyTarget("ArrowUp", -1, 100, 10)).toBeNull();
		expect(graphKeyTarget("PageUp", -1, 100, 10)).toBeNull();
	});

	it("moves nowhere in an empty list", () => {
		expect(graphKeyTarget("End", -1, 0, 10)).toBeNull();
	});
});

describe("isGraphKey", () => {
	it("takes the navigation keys and nothing chorded", () => {
		expect(isGraphKey("PageDown")).toBe(true);
		expect(isGraphKey("Shift+ArrowDown")).toBe(false);
		expect(isGraphKey("Enter")).toBe(false);
	});
});
