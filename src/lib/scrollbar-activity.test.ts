import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackScrollActivity } from "./scrollbar-activity.js";

const REVEALED = "var(--color-scrollbar-thumb)";
const WITHIN_LINGER_MS = 800;
const PAST_LINGER_MS = 2000;

function makeScroller({ scrollHeight = 1000, clientHeight = 200 } = {}) {
	const el = document.createElement("div");
	Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
	Object.defineProperty(el, "clientHeight", { value: clientHeight });
	document.body.append(el);
	return el;
}

const thumbOf = (el: HTMLElement) =>
	el.style.getPropertyValue("--scrollbar-thumb-paint");

let stop: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	stop = trackScrollActivity();
});

afterEach(() => {
	stop();
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("trackScrollActivity", () => {
	it("reveals the thumb while a scroller scrolls", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe(REVEALED);
	});

	it("hides the thumb once scrolling stops", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbOf(el)).toBe("transparent");
	});

	it("keeps the thumb up while scrolling continues", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(WITHIN_LINGER_MS);
		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(WITHIN_LINGER_MS);

		expect(thumbOf(el)).toBe(REVEALED);
	});

	it.each([
		{ name: "nothing to scroll", overflow: 0 },
		{ name: "a rounding artifact", overflow: 1 },
		{ name: "exactly the ignored maximum", overflow: 2 },
	])("ignores a scroller with $name", ({ overflow }) => {
		const el = makeScroller({
			scrollHeight: 200 + overflow,
			clientHeight: 200,
		});

		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe("");
	});

	it("reveals a scroller one pixel past the ignored maximum", () => {
		const el = makeScroller({ scrollHeight: 203, clientHeight: 200 });

		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe(REVEALED);
	});

	it("reveals each scroller independently", () => {
		const scrolled = makeScroller();
		const untouched = makeScroller();

		scrolled.dispatchEvent(new Event("scroll"));

		expect(thumbOf(scrolled)).toBe(REVEALED);
		expect(thumbOf(untouched)).toBe("");
	});

	it("stops responding once torn down", () => {
		const el = makeScroller();

		stop();
		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe("");
	});
});
