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

	it("uses the rendered height when the same paragraph wraps at a narrower width", () => {
		const paragraph = "Review the queued changes. ".repeat(12);
		expect(bodyOverflows(paragraph, 12)).toBe(true);
		expect(bodyOverflows(paragraph, 7)).toBe(false);
	});

	it("is false for a short single-line body", () => {
		expect(bodyOverflows("a one line body")).toBe(false);
	});
});
