import { describe, expect, it } from "vitest";
import { BODY_CLAMP_LINES, bodyOverflows } from "./commit-body-clamp.js";

describe("bodyOverflows", () => {
	it("is false for a body with no text", () => {
		expect(bodyOverflows(null)).toBe(false);
		expect(bodyOverflows("")).toBe(false);
	});

	it("is false for a body exactly at the clamp", () => {
		const body = Array.from(
			{ length: BODY_CLAMP_LINES },
			(_, i) => `line ${i}`,
		).join("\n");
		expect(bodyOverflows(body)).toBe(false);
	});

	it("is true one line past the clamp", () => {
		const body = Array.from(
			{ length: BODY_CLAMP_LINES + 1 },
			(_, i) => `line ${i}`,
		).join("\n");
		expect(bodyOverflows(body)).toBe(true);
	});

	// The body renders with `white-space: pre-wrap`, so a single long paragraph
	// wraps into several rendered lines even though it holds one newline-free
	// string. Counting newlines alone would call this body short and drop the
	// control the reader needs.
	it("counts a wrapped long paragraph as more than one line", () => {
		const body = "word ".repeat(400).trim();
		expect(bodyOverflows(body)).toBe(true);
	});

	it("is false for a short single-line body", () => {
		expect(bodyOverflows("a one line body")).toBe(false);
	});
});
