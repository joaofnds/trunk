import { describe, expect, it } from "vitest";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import {
	ALL_THREADS,
	badgeToneForThread,
	combineReviewTone,
	countBadgeThreads,
	filterThreads,
	presetOf,
	THREAD_PRESETS,
	tallyBadgeThreads,
	toggleStale,
	toggleState,
} from "./review-filter.js";
import type { ReviewFilter } from "./types.js";

function preset(id: (typeof THREAD_PRESETS)[number]["id"]): ReviewFilter {
	const found = THREAD_PRESETS.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`no preset ${id}`);
	return found.filter;
}

describe("review filter projection", () => {
	const open = aThread({ id: "open", state: "open" });
	const addressed = aThread({ id: "addressed", state: "addressed" });
	const done = aThread({ id: "done", state: "done" });
	const dismissed = aThread({ id: "dismissed", state: "dismissed" });
	const staleDone = aThread({ id: "stale", state: "done", stale: true });
	const threads = [open, addressed, done, dismissed, staleDone];

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
		["needs", ["open", "addressed"]],
		["settled", ["done", "dismissed", "stale"]],
	] as const)("shows the %s preset's threads", (id, ids) => {
		expect(filterThreads(threads, preset(id)).map((t) => t.id)).toEqual(ids);
	});

	it("shows the threads in any of a filter's states", () => {
		const filter = { states: ["open", "done"], stale: true } as const;

		expect(filterThreads(threads, filter).map((t) => t.id)).toEqual([
			"open",
			"done",
			"stale",
		]);
	});

	it("hides a stale thread while stale threads are off", () => {
		const filter = { ...ALL_THREADS, stale: false };

		expect(filterThreads(threads, filter).map((t) => t.id)).not.toContain(
			"stale",
		);
	});

	it("shows nothing while review threads are hidden", () => {
		expect(filterThreads(threads, "none")).toEqual([]);
	});

	it("pills only open and addressed threads while every thread shows", () => {
		expect(countBadgeThreads(threads, ALL_THREADS)).toBe(2);
		expect(badgeToneForThread(done, ALL_THREADS)).toBeNull();
	});

	it("pills each shown thread in its own state's tone under a narrower filter", () => {
		expect(badgeToneForThread(staleDone, preset("settled"))).toBe("done");
		expect(badgeToneForThread(dismissed, preset("settled"))).toBe("dismissed");
		expect(badgeToneForThread(open, preset("settled"))).toBeNull();
	});
});

describe("presetOf", () => {
	it.each(["all", "needs", "settled"] as const)(
		"names the %s preset from its filter",
		(id) => {
			expect(presetOf(preset(id))).toBe(id);
		},
	);

	it("names the preset whatever order its states are in", () => {
		expect(presetOf({ states: ["addressed", "open"], stale: true })).toBe(
			"needs",
		);
	});

	it("names no preset for a mix of states no preset holds", () => {
		expect(presetOf({ states: ["open", "done"], stale: true })).toBeNull();
	});

	it("names no preset while stale threads are off", () => {
		expect(presetOf({ ...ALL_THREADS, stale: false })).toBeNull();
	});

	it("names no preset while review threads are hidden", () => {
		expect(presetOf("none")).toBeNull();
	});
});

describe("tallyBadgeThreads", () => {
	const threads = [
		aThread({ id: "o1", state: "open" }),
		aThread({ id: "o2", state: "open" }),
		aThread({ id: "a1", state: "addressed" }),
		aThread({ id: "d1", state: "done" }),
	];

	it("counts the unresolved threads by state while every thread shows", () => {
		expect(tallyBadgeThreads(threads, ALL_THREADS)).toEqual({
			open: 2,
			addressed: 1,
		});
	});

	it("counts only the shown states under a narrower filter", () => {
		expect(tallyBadgeThreads(threads, preset("settled"))).toEqual({ done: 1 });
	});

	it("counts nothing while review threads are hidden", () => {
		expect(tallyBadgeThreads(threads, "none")).toEqual({});
	});
});

describe("toggleState", () => {
	it("hides a state that shows", () => {
		expect(toggleState(ALL_THREADS, "done")).toEqual({
			states: ["open", "addressed", "dismissed"],
			stale: true,
		});
	});

	it("shows a hidden state in the tally's order", () => {
		expect(toggleState({ states: ["done"], stale: false }, "open")).toEqual({
			states: ["open", "done"],
			stale: false,
		});
	});

	it("shows only the pressed state while review threads are hidden", () => {
		expect(toggleState("none", "addressed")).toEqual({
			states: ["addressed"],
			stale: true,
		});
	});
});

describe("toggleStale", () => {
	it.each([true, false])("flips stale threads from %s", (stale) => {
		expect(toggleStale({ ...ALL_THREADS, stale })).toEqual({
			...ALL_THREADS,
			stale: !stale,
		});
	});

	it("turns only the stale threads on while review threads are hidden", () => {
		expect(toggleStale("none")).toEqual({ states: [], stale: true });
	});
});
