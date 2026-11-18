import { describe, expect, it } from "vitest";
import { sameData } from "./same-data";

describe("sameData", () => {
	it("holds two copies of the same nested data equal", () => {
		const read = () => [{ path: "a", hunks: [{ lines: [{ n: 1, s: null }] }] }];

		expect(sameData(read(), read())).toBe(true);
	});

	it("tells apart data that differs deep inside", () => {
		expect(sameData([{ lines: [1, 2] }], [{ lines: [1, 3] }])).toBe(false);
	});

	it("tells apart arrays of different lengths", () => {
		expect(sameData([1, 2], [1, 2, 3])).toBe(false);
	});

	it("tells apart an object that has an extra key", () => {
		expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	it("counts a key holding undefined as absent", () => {
		expect(sameData({ a: 1, pairing: undefined }, { a: 1 })).toBe(true);
	});

	it("tells an array from an object with the same entries", () => {
		expect(sameData([1], { 0: 1 })).toBe(false);
	});

	it("tells null from an empty object", () => {
		expect(sameData(null, {})).toBe(false);
	});
});
