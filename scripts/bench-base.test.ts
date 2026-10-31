import { describe, expect, it } from "vitest";
import { chooseBase } from "./bench-base.js";

const BEFORE = "1ea527ec0000000000000000000000000000000a";
const PARENT = "3663c6a50000000000000000000000000000000b";
const ZERO = "0000000000000000000000000000000000000000";

describe("chooseBase", () => {
	it("takes the commit main held before the push", () => {
		const base = chooseBase({
			before: BEFORE,
			beforeIsAncestor: true,
			parent: PARENT,
		});

		expect(base).toEqual({
			sha: BEFORE,
			reason: "the commit main held before the push",
		});
	});

	describe("when the push created the branch", () => {
		it("falls back to the pushed commit's parent", () => {
			const base = chooseBase({
				before: ZERO,
				beforeIsAncestor: false,
				parent: PARENT,
			});

			expect(base).toEqual({
				sha: PARENT,
				reason:
					"the push carries no previous commit, so the pushed commit's parent",
			});
		});
	});

	describe("when the previous commit is not an ancestor of the pushed one", () => {
		it("falls back to the pushed commit's parent", () => {
			const base = chooseBase({
				before: BEFORE,
				beforeIsAncestor: false,
				parent: PARENT,
			});

			expect(base).toEqual({
				sha: PARENT,
				reason: `the previous commit ${BEFORE} is not an ancestor of the pushed one, so the pushed commit's parent`,
			});
		});
	});
});
