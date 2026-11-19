import { describe, expect, it } from "vitest";
import { isSideways } from "./wheel.js";

describe("isSideways", () => {
	it.each([
		{ deltaX: 40, deltaY: 0, sideways: true },
		{ deltaX: 40, deltaY: 30, sideways: true },
		{ deltaX: -40, deltaY: 30, sideways: true },
		{ deltaX: 2, deltaY: 40, sideways: false },
		{ deltaX: 30, deltaY: -40, sideways: false },
		{ deltaX: 30, deltaY: 30, sideways: false },
	])(
		"reads deltaX $deltaX and deltaY $deltaY as sideways: $sideways",
		({ deltaX, deltaY, sideways }) => {
			expect(isSideways(new WheelEvent("wheel", { deltaX, deltaY }))).toBe(
				sideways,
			);
		},
	);
});
