import { describe, expect, it } from "vitest";
import { moveTab } from "./tab-order.js";
import type { TabInfo } from "./tab-types.js";

const strip: TabInfo[] = ["first", "second", "third"].map((name) => ({
	id: name,
	repoPath: null,
	repoName: name,
	dirty: false,
}));

function namesAfter(id: string, step: -1 | 1): string[] {
	return moveTab(strip, id, step).map(({ id }) => id);
}

describe("moveTab", () => {
	it.each([
		{ id: "first", step: -1 as const },
		{ id: "third", step: 1 as const },
		{ id: "closed", step: 1 as const },
	])("leaves the strip as it is for $id moving $step", ({ id, step }) => {
		expect(namesAfter(id, step)).toEqual(["first", "second", "third"]);
	});

	it("leaves the strip it was given untouched", () => {
		namesAfter("second", 1);

		expect(strip.map(({ id }) => id)).toEqual(["first", "second", "third"]);
	});
});
