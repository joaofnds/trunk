import { describe, expect, it } from "vitest";
import { exactLabel, relativeLabel } from "./relative-time.js";

const nowMinute = 30_000_000;

describe("relativeLabel", () => {
	it.each([
		{ name: "the current minute", m: 0, expected: "just now" },
		{ name: "one minute", m: 1, expected: "1m ago" },
		{ name: "the last whole minute", m: 59, expected: "59m ago" },
		{ name: "the first whole hour", m: 60, expected: "1h ago" },
		{ name: "the last whole hour", m: 1439, expected: "23h ago" },
		{ name: "the first whole day", m: 1440, expected: "1d ago" },
		{ name: "the last whole day", m: 43199, expected: "29d ago" },
		{ name: "the first whole month", m: 43200, expected: "1mo ago" },
		{ name: "the last whole month", m: 525599, expected: "12mo ago" },
		{ name: "the first whole year", m: 525600, expected: "1y ago" },
	])("renders $name as $expected", ({ m, expected }) => {
		expect(relativeLabel((nowMinute - m) * 60, nowMinute)).toBe(expected);
	});

	it("renders an absent timestamp as an empty label", () => {
		expect(relativeLabel(0, nowMinute)).toBe("");
	});

	it("clamps a future timestamp to just now", () => {
		expect(relativeLabel((nowMinute + 90) * 60, nowMinute)).toBe("just now");
	});

	it("floors a timestamp to its own calendar minute", () => {
		expect(relativeLabel(nowMinute * 60 + 59, nowMinute)).toBe("just now");
	});

	it("counts a timestamp one second into the previous calendar minute as a minute", () => {
		expect(relativeLabel(nowMinute * 60 - 1, nowMinute)).toBe("1m ago");
	});
});

describe("exactLabel", () => {
	// Locale and zone are pinned here so the assertion is deterministic across
	// machines; production callers pass neither and get the user's own.
	const pinned = { locale: "en-US", timeZone: "UTC" } as const;

	it("renders the full date and time with the zone", () => {
		const ts = Date.UTC(2026, 7, 30, 12, 34, 56) / 1000;
		expect(exactLabel(ts, pinned)).toBe("Aug 30, 2026, 12:34:56 PM UTC");
	});

	it("renders an absent timestamp as an empty label", () => {
		expect(exactLabel(0, pinned)).toBe("");
	});
});
