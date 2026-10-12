import { describe, expect, it } from "vitest";
import { diffCanTakeComments, diffTakesComments } from "./takes-comments.js";

describe("diffTakesComments", () => {
	it.each([
		{
			view: "a graph, staging or rebase diff with threads shown",
			compare: false,
			reviewMode: false,
			threadsHidden: false,
			takes: true,
		},
		{
			view: "a graph, staging or rebase diff with threads hidden",
			compare: false,
			reviewMode: false,
			threadsHidden: true,
			takes: false,
		},
		{
			view: "a review-mode diff with threads shown",
			compare: false,
			reviewMode: true,
			threadsHidden: false,
			takes: true,
		},
		{
			view: "a review-mode diff with threads hidden",
			compare: false,
			reviewMode: true,
			threadsHidden: true,
			takes: true,
		},
		{
			view: "a compare with threads shown",
			compare: true,
			reviewMode: false,
			threadsHidden: false,
			takes: false,
		},
		{
			view: "a compare in review mode",
			compare: true,
			reviewMode: true,
			threadsHidden: false,
			takes: false,
		},
	])(
		"decides $takes for $view",
		({ compare, reviewMode, threadsHidden, takes }) => {
			expect(diffTakesComments({ compare, reviewMode, threadsHidden })).toBe(
				takes,
			);
		},
	);
});

describe("diffCanTakeComments", () => {
	it("lets every diff but a compare take a comment", () => {
		expect(diffCanTakeComments({ compare: false })).toBe(true);
		expect(diffCanTakeComments({ compare: true })).toBe(false);
	});
});
