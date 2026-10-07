import { describe, expect, it } from "vitest";
import { reviewTitle, titleRuns } from "./review-title.js";

describe("reviewTitle", () => {
	it("drops the short id an older default title repeated", () => {
		expect(
			reviewTitle({ id: "SDAA9GZS", title: "Review 2026-10-06 · SDAA9GZS" }),
		).toBe("Review 2026-10-06");
	});

	it("keeps a title the reader wrote, id and all", () => {
		expect(
			reviewTitle({ id: "SDAA9GZS", title: "Watcher fixes · SDAA9GZS" }),
		).toBe("Watcher fixes · SDAA9GZS");
	});

	it("keeps another review's id in a default title", () => {
		expect(
			reviewTitle({ id: "SDAA9GZS", title: "Review 2026-10-06 · 78TYW623" }),
		).toBe("Review 2026-10-06 · 78TYW623");
	});
});

describe("titleRuns", () => {
	it("holds each ISO date as one run that may not break", () => {
		expect(titleRuns("Review 2026-09-08 then 2026-10-01")).toEqual([
			{ text: "Review ", whole: false },
			{ text: "2026-09-08", whole: true },
			{ text: " then ", whole: false },
			{ text: "2026-10-01", whole: true },
		]);
	});

	it("is the title alone when it holds no date", () => {
		expect(titleRuns("PATH resolution")).toEqual([
			{ text: "PATH resolution", whole: false },
		]);
	});
});
