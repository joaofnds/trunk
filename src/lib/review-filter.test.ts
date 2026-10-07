import { describe, expect, it } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	badgeToneForThread,
	combineReviewTone,
	countBadgeThreads,
	countByFilter,
	filterThreads,
	tallyBadgeThreads,
	threadMatchesFilter,
} from "./review-filter.js";

describe("review filter projection", () => {
	const open = aThread({ id: "open", state: "open" });
	const addressed = aThread({ id: "addressed", state: "addressed" });
	const done = aThread({ id: "done", state: "done" });
	const dismissed = aThread({ id: "dismissed", state: "dismissed" });
	const staleDone = aThread({ id: "stale", state: "done", stale: true });

	it.each([
		["open", "addressed"],
		["addressed", "open"],
	] as const)(
		"prioritizes open work when combining %s then %s",
		(first, next) => {
			expect(combineReviewTone(first, next)).toBe("open");
		},
	);

	it.each([
		["all", ["open", "addressed", "done", "dismissed", "stale"]],
		["open", ["open"]],
		["addressed", ["addressed"]],
		["done", ["done", "stale"]],
		["dismissed", ["dismissed"]],
		["stale", ["stale"]],
		["none", []],
	] as const)("matches the %s bucket", (filter, ids) => {
		const threads = [open, addressed, done, dismissed, staleDone];
		expect(filterThreads(threads, filter).map((thread) => thread.id)).toEqual(
			ids,
		);
	});

	it("counts unresolved threads by default but every matching state explicitly", () => {
		const threads = [open, addressed, done, dismissed, staleDone];
		expect(countBadgeThreads(threads, "all")).toBe(2);
		expect(countBadgeThreads(threads, "done")).toBe(2);
		expect(countBadgeThreads(threads, "stale")).toBe(1);
	});

	it("uses the filter tone, with stale taking precedence in the stale bucket", () => {
		expect(badgeToneForThread(open, "all")).toBe("open");
		expect(badgeToneForThread(addressed, "all")).toBe("addressed");
		expect(badgeToneForThread(done, "all")).toBeNull();
		expect(badgeToneForThread(staleDone, "stale")).toBe("stale");
		expect(threadMatchesFilter(staleDone, "done")).toBe(true);
	});
});

describe("tallyBadgeThreads", () => {
	const threads = [
		aThread({ id: "o1", state: "open" }),
		aThread({ id: "o2", state: "open" }),
		aThread({ id: "a1", state: "addressed" }),
		aThread({ id: "d1", state: "done" }),
	];

	it("counts the unresolved threads by state under All threads", () => {
		expect(tallyBadgeThreads(threads, "all")).toEqual({
			open: 2,
			addressed: 1,
		});
	});

	it("counts only the filter's state under an explicit filter", () => {
		expect(tallyBadgeThreads(threads, "done")).toEqual({ done: 1 });
	});

	it("counts nothing under Hide all", () => {
		expect(tallyBadgeThreads(threads, "none")).toEqual({});
	});
});

describe("countByFilter", () => {
	it("counts how many threads each visible filter would show", () => {
		const threads = [
			aThread({ id: "o1", state: "open" }),
			aThread({ id: "o2", state: "open", stale: true }),
			aThread({ id: "d1", state: "done" }),
		];

		expect(countByFilter(threads)).toEqual({
			all: 3,
			open: 2,
			addressed: 0,
			done: 1,
			dismissed: 0,
			stale: 1,
		});
	});
});
