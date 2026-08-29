import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dragScrollTop,
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
	el.style.overflowY = "auto";
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
	const expectedRight = `${window.innerWidth - rect.right + 3 - 5}px`;
	return (
		[...document.body.querySelectorAll<HTMLDivElement>(`.${THUMB_CLASS}`)].find(
			(thumb) => thumb.style.right === expectedRight,
		) ?? null
	);
}

function press(thumb: HTMLElement | null, clientY: number) {
	thumb?.dispatchEvent(
		new MouseEvent("pointerdown", { bubbles: true, clientY }),
	);
}

function movePointerTo(clientY: number) {
	window.dispatchEvent(
		new MouseEvent("pointermove", { bubbles: true, clientY }),
	);
}

function release() {
	window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}

function pointerOver(el: HTMLElement) {
	el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
}

function pointerOut(el: HTMLElement, into: HTMLElement | null = null) {
	el.dispatchEvent(
		new MouseEvent("pointerout", { bubbles: true, relatedTarget: into }),
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

describe("dragScrollTop", () => {
	const pane = {
		startScrollTop: 0,
		trackHeight: 200,
		thumbHeight: 40,
		scrollHeight: 1000,
		clientHeight: 200,
	};

	it("moves the content by the share of the track the thumb travelled", () => {
		expect(dragScrollTop({ ...pane, deltaY: 80 })).toBe(400);
	});

	it("follows the pointer back up", () => {
		expect(dragScrollTop({ ...pane, startScrollTop: 400, deltaY: -80 })).toBe(
			0,
		);
	});

	it("stops at the top however far past it the pointer goes", () => {
		expect(dragScrollTop({ ...pane, deltaY: -500 })).toBe(0);
	});

	it("stops at the bottom however far past it the pointer goes", () => {
		expect(dragScrollTop({ ...pane, deltaY: 500 })).toBe(800);
	});

	it("holds position when the thumb fills the track and has nowhere to travel", () => {
		expect(
			dragScrollTop({
				...pane,
				startScrollTop: 120,
				thumbHeight: 200,
				deltaY: 50,
			}),
		).toBe(120);
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
		expect(thumb?.style.right).toBe(`${window.innerWidth - 210 + 3 - 5}px`);
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

	it("scrolls the pane in proportion to how far the thumb is dragged", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));

		press(thumbFor(el), 100);
		movePointerTo(180);

		expect(el.scrollTop).toBe(400);
	});

	it("stops following the pointer once the thumb is released", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));

		press(thumbFor(el), 100);
		movePointerTo(180);
		release();
		movePointerTo(500);

		expect(el.scrollTop).toBe(400);
	});

	it("holds the thumb up for the whole drag, however long the user pauses", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));

		press(thumbFor(el), 100);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("lets the thumb fade again once the drag ends", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));

		press(thumbFor(el), 100);
		release();
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).toBeNull();
	});

	it("reveals the thumb while the pointer rests over a scrollable pane", () => {
		const el = makeScroller();

		pointerOver(el);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("reveals the thumb from an SVG child, as the commit graph's overlay is", () => {
		const el = makeScroller();
		const overlay = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"circle",
		);
		el.append(overlay);

		overlay.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));

		expect(thumbFor(el)).not.toBeNull();
	});

	it("holds the thumb up for as long as the pointer stays in the pane", () => {
		const el = makeScroller();

		pointerOver(el);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("lets the thumb fade once the pointer leaves the pane", () => {
		const el = makeScroller();

		pointerOver(el);
		pointerOut(el);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).toBeNull();
	});

	it("keeps the thumb up while the pointer moves between rows inside the pane", () => {
		const el = makeScroller();
		const row = document.createElement("div");
		el.append(row);

		pointerOver(el);
		pointerOut(el, row);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("keeps the thumb up when the pointer crosses from the pane onto the thumb", () => {
		const el = makeScroller();

		pointerOver(el);
		pointerOut(el, thumbFor(el));
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("holds the thumb up while the pointer rests on the thumb itself", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));
		const thumb = thumbFor(el);

		pointerOver(thumb as HTMLElement);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("lets the thumb fade once the pointer leaves it for something else", () => {
		const el = makeScroller();
		const elsewhere = document.createElement("div");
		document.body.append(elsewhere);
		el.dispatchEvent(new Event("scroll"));
		const thumb = thumbFor(el);

		pointerOver(thumb as HTMLElement);
		pointerOut(thumb as HTMLElement, elsewhere);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).toBeNull();
	});

	it("reveals nothing over a pane with nothing to scroll", () => {
		const el = makeScroller({ scrollHeight: 200, clientHeight: 200 });

		pointerOver(el);

		expect(thumbFor(el)).toBeNull();
	});

	it("stops revealing on hover once torn down", () => {
		const el = makeScroller();

		stop();
		pointerOver(el);

		expect(thumbFor(el)).toBeNull();
	});

	it("clears a pending hide timer and its thumb on teardown", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		stop();

		expect(document.body.querySelector(`.${THUMB_CLASS}`)).toBeNull();
	});
});
