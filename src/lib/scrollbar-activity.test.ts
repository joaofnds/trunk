import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	THUMB_CLASS,
	thumbGeometry,
	trackScrollActivity,
} from "./scrollbar-activity.js";

const WITHIN_LINGER_MS = 800;
const PAST_LINGER_MS = 2000;

function makeScroller({
	scrollHeight = 1000,
	clientHeight = 200,
	right = 210,
} = {}) {
	const el = document.createElement("div");
	Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
	Object.defineProperty(el, "clientHeight", { value: clientHeight });
	Object.defineProperty(el, "scrollTop", { value: 0, writable: true });
	el.getBoundingClientRect = () =>
		({ top: 10, right, height: clientHeight }) as DOMRect;
	document.body.append(el);
	return el;
}

// Each scroller's thumb sits at a distinct `right`, so this finds the one
// belonging to a given scroller rather than assuming there is only one.
function thumbFor(el: HTMLElement): HTMLDivElement | null {
	const rect = el.getBoundingClientRect();
	const expectedRight = `${window.innerWidth - rect.right + 3}px`;
	return (
		[...document.body.querySelectorAll<HTMLDivElement>(`.${THUMB_CLASS}`)].find(
			(thumb) => thumb.style.right === expectedRight,
		) ?? null
	);
}

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

describe("thumbGeometry", () => {
	it("sizes the thumb proportionally to how much of the content is visible", () => {
		expect(thumbGeometry(0, 200, 0, 1000, 200).height).toBe(40);
	});

	it("floors the thumb height so a tiny fraction stays grabbable", () => {
		expect(thumbGeometry(0, 200, 0, 100000, 200).height).toBe(24);
	});

	it("places the thumb at the track's start when scrolled to the top", () => {
		expect(thumbGeometry(10, 200, 0, 1000, 200).top).toBe(10);
	});

	it("places the thumb at the track's end when scrolled to the bottom", () => {
		const { top, height } = thumbGeometry(10, 200, 800, 1000, 200);

		expect(top + height).toBe(210);
	});

	it("interpolates position between the two ends", () => {
		const { top } = thumbGeometry(0, 200, 400, 1000, 200);

		expect(top).toBeCloseTo(80, 5);
	});
});

describe("trackScrollActivity", () => {
	it("appends a themed thumb overlay while a scroller scrolls", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));

		const thumb = thumbFor(el);
		expect(thumb).not.toBeNull();
		expect(thumb?.style.height).toBe("40px");
	});

	it("positions the thumb from the scroller's own viewport edge, as a body-level overlay", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));

		const thumb = thumbFor(el);
		expect(thumb?.parentElement).toBe(document.body);
		expect(thumb?.style.right).toBe(`${window.innerWidth - 210 + 3}px`);
	});

	it("removes the thumb once scrolling stops", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).toBeNull();
	});

	it("keeps the thumb up while scrolling continues", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(WITHIN_LINGER_MS);
		el.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(WITHIN_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
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

		expect(thumbFor(el)).toBeNull();
	});

	it("reveals a scroller one pixel past the ignored maximum", () => {
		const el = makeScroller({ scrollHeight: 203, clientHeight: 200 });

		el.dispatchEvent(new Event("scroll"));

		expect(thumbFor(el)).not.toBeNull();
	});

	it("stops responding once torn down", () => {
		const el = makeScroller();

		stop();
		el.dispatchEvent(new Event("scroll"));

		expect(thumbFor(el)).toBeNull();
	});

	it("reveals each scroller independently", () => {
		const scrolled = makeScroller({ right: 210 });
		const untouched = makeScroller({ right: 500 });

		scrolled.dispatchEvent(new Event("scroll"));

		expect(thumbFor(scrolled)).not.toBeNull();
		expect(thumbFor(untouched)).toBeNull();
	});

	it("clears a pending hide timer and its thumb on teardown", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		stop();

		expect(document.body.querySelector(`.${THUMB_CLASS}`)).toBeNull();
	});
});
