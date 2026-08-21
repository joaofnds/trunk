import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackScrollActivity } from "./scrollbar-activity.js";

function makeScroller({ scrollHeight = 1000, clientHeight = 200 } = {}) {
	const el = document.createElement("div");
	Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
	Object.defineProperty(el, "clientHeight", { value: clientHeight });
	document.body.append(el);
	return el;
}

const thumbOf = (el: HTMLElement) =>
	el.style.getPropertyValue("--scrollbar-thumb");

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
	it("leaves a scroller's thumb transparent until it scrolls", () => {
		const el = makeScroller();

		expect(thumbOf(el)).toBe("");
	});

	it("reveals the thumb while a scroller scrolls", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe("var(--color-scrollbar-thumb)");
	});

	it("hides the thumb once scrolling stops", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(2000);

		expect(thumbOf(el)).toBe("transparent");
	});

	it("keeps the thumb up while scrolling continues", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(800);
		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(800);

		expect(thumbOf(el)).toBe("var(--color-scrollbar-thumb)");
	});

	it("ignores a scroller with nothing to scroll", () => {
		const el = makeScroller({ scrollHeight: 200, clientHeight: 200 });

		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe("");
	});

	it("ignores a scroller whose overflow is a rounding artifact", () => {
		const el = makeScroller({ scrollHeight: 201, clientHeight: 200 });

		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe("");
	});

	it("reveals each scroller independently", () => {
		const scrolled = makeScroller();
		const untouched = makeScroller();

		scrolled.dispatchEvent(new Event("scroll"));

		expect(thumbOf(scrolled)).toBe("var(--color-scrollbar-thumb)");
		expect(thumbOf(untouched)).toBe("");
	});

	it("stops responding once torn down", () => {
		const el = makeScroller();

		stop();
		el.dispatchEvent(new Event("scroll"));

		expect(thumbOf(el)).toBe("");
	});
});
