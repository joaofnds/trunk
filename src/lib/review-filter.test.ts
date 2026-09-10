import { describe, expect, it } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	badgeToneForThread,
	countBadgeThreads,
	filterThreads,
	threadMatchesFilter,
} from "./review-filter.js";

describe("review filter projection", () => {
	const open = aThread({ id: "open", state: "open" });
	const addressed = aThread({ id: "addressed", state: "addressed" });
	const done = aThread({ id: "done", state: "done" });
	const dismissed = aThread({ id: "dismissed", state: "dismissed" });
	const staleDone = aThread({ id: "stale", state: "done", stale: true });

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
