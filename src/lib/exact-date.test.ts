import { describe, expect, it } from "vitest";
import { exactDate } from "./exact-date.js";
import { exactLabel } from "./relative-time.js";

const ts = Date.UTC(2026, 7, 30, 12, 34, 56) / 1000;

describe("exactDate", () => {
	it("carries the exact date as the accessible name", () => {
		const node = document.createElement("span");
		const action = exactDate(node, ts);

		expect(node.getAttribute("aria-label")).toBe(exactLabel(ts));
		action.destroy();
	});

	it("drops the accessible name when the timestamp goes absent", () => {
		const node = document.createElement("span");
		const action = exactDate(node, ts);

		action.update(0);

		expect(node.hasAttribute("aria-label")).toBe(false);
		action.destroy();
	});
});
