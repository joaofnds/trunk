import { describe, expect, it } from "vitest";
import { ALL_THREADS } from "./review-filter.js";
import { diffTakesComments } from "./takes-comments.js";

describe("diffTakesComments", () => {
	it.each([
		{
			view: "a graph, staging or rebase diff with threads shown",
			compare: false,
			reviewMode: false,
			reviewFilter: ALL_THREADS,
			takes: true,
		},
		{
			view: "a graph, staging or rebase diff with threads hidden",
			compare: false,
			reviewMode: false,
			reviewFilter: "none" as const,
			takes: false,
		},
		{
			view: "a review-mode diff with threads shown",
			compare: false,
			reviewMode: true,
			reviewFilter: ALL_THREADS,
			takes: true,
		},
		{
			view: "a review-mode diff with threads hidden",
			compare: false,
			reviewMode: true,
			reviewFilter: "none" as const,
			takes: true,
		},
		{
			view: "a compare with threads shown",
			compare: true,
			reviewMode: false,
			reviewFilter: ALL_THREADS,
			takes: false,
		},
		{
			view: "a compare in review mode",
			compare: true,
			reviewMode: true,
			reviewFilter: ALL_THREADS,
			takes: false,
		},
	])(
		"decides $takes for $view",
		({ compare, reviewMode, reviewFilter, takes }) => {
			expect(diffTakesComments({ compare, reviewMode, reviewFilter })).toBe(
				takes,
			);
		},
	);
});
