import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dragScrollPosition,
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
	const expectedRight = `${window.innerWidth - rect.right + 3}px`;
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

function pointerEnter(el: HTMLElement) {
	el.dispatchEvent(new MouseEvent("pointerenter"));
}

function pointerLeave(el: HTMLElement) {
	el.dispatchEvent(new MouseEvent("pointerleave"));
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
	const pane = {
		trackStart: 0,
		trackLength: 200,
		scrolled: 0,
		scrollLength: 1000,
		clientLength: 200,
	};

	it("sizes the thumb proportionally to how much of the content is visible", () => {
		expect(thumbGeometry(pane).length).toBe(40);
	});

	it("floors the thumb length so a tiny fraction stays grabbable", () => {
		expect(thumbGeometry({ ...pane, scrollLength: 100000 }).length).toBe(24);
	});

	it("places the thumb at the track's start when scrolled to the start", () => {
		expect(thumbGeometry({ ...pane, trackStart: 10 }).start).toBe(10);
	});

	it("places the thumb at the track's end when scrolled to the end", () => {
		const { start, length } = thumbGeometry({
			...pane,
			trackStart: 10,
			scrolled: 800,
		});

		expect(start + length).toBe(210);
	});

	it("interpolates position between the two ends", () => {
		const { start } = thumbGeometry({ ...pane, scrolled: 400 });

		expect(start).toBeCloseTo(80, 5);
	});
});

describe("dragScrollPosition", () => {
	const pane = {
		startScrolled: 0,
		trackLength: 200,
		thumbLength: 40,
		scrollLength: 1000,
		clientLength: 200,
	};

	it("moves the content by the share of the track the thumb travelled", () => {
		expect(dragScrollPosition({ ...pane, pointerTravel: 80 })).toBe(400);
	});

	it("follows the pointer back", () => {
		expect(
			dragScrollPosition({ ...pane, startScrolled: 400, pointerTravel: -80 }),
		).toBe(0);
	});

	it("stops at the start however far past it the pointer goes", () => {
		expect(dragScrollPosition({ ...pane, pointerTravel: -500 })).toBe(0);
	});

	it("stops at the end however far past it the pointer goes", () => {
		expect(dragScrollPosition({ ...pane, pointerTravel: 500 })).toBe(800);
	});

	it("holds position when the thumb fills the track and has nowhere to travel", () => {
		expect(
			dragScrollPosition({
				...pane,
				startScrolled: 120,
				thumbLength: 200,
				pointerTravel: 50,
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

	// The stylesheet gives a thumb its 5px thickness by this name alone.
	it("names the thumb's axis, which the stylesheet sizes it by", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));

		expect(thumbFor(el)?.dataset.axis).toBe("vertical");
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

	it("holds the thumb up while the pointer rests on the thumb itself", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));
		const thumb = thumbFor(el);

		pointerEnter(thumb as HTMLElement);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).not.toBeNull();
	});

	it("lets the thumb fade once the pointer leaves it for something else", () => {
		const el = makeScroller();
		el.dispatchEvent(new Event("scroll"));
		const thumb = thumbFor(el);

		pointerEnter(thumb as HTMLElement);
		pointerLeave(thumb as HTMLElement);
		vi.advanceTimersByTime(PAST_LINGER_MS);

		expect(thumbFor(el)).toBeNull();
	});

	it("clears a pending hide timer and its thumb on teardown", () => {
		const el = makeScroller();

		el.dispatchEvent(new Event("scroll"));
		stop();

		expect(document.body.querySelector(`.${THUMB_CLASS}`)).toBeNull();
	});

	describe("when a pane scrolls sideways", () => {
		function makePane({
			scrollWidth = 1000,
			clientWidth = 200,
			scrollHeight = 0,
			clientHeight = 0,
			bottom = 300,
			overflowX = "auto",
		} = {}) {
			const el = document.createElement("div");
			el.style.overflowX = overflowX;
			Object.defineProperty(el, "scrollWidth", { value: scrollWidth });
			Object.defineProperty(el, "clientWidth", { value: clientWidth });
			Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
			Object.defineProperty(el, "clientHeight", { value: clientHeight });
			el.getBoundingClientRect = () =>
				({
					top: bottom - clientHeight,
					right: 10 + clientWidth,
					bottom,
					left: 10,
					width: clientWidth,
					height: clientHeight,
				}) as DOMRect;
			document.body.append(el);
			return el;
		}

		function scrollSidewaysTo(el: HTMLElement, scrollLeft: number) {
			el.scrollLeft = scrollLeft;
			el.dispatchEvent(new Event("scroll"));
		}

		// A sideways thumb hangs off the pane's bottom edge, so this finds it by
		// that edge, as thumbFor finds a vertical one by its right edge.
		function sidewaysThumbFor(el: HTMLElement): HTMLDivElement | null {
			const rect = el.getBoundingClientRect();
			const expectedBottom = `${window.innerHeight - rect.bottom + 3}px`;
			return (
				[
					...document.body.querySelectorAll<HTMLDivElement>(`.${THUMB_CLASS}`),
				].find((thumb) => thumb.style.bottom === expectedBottom) ?? null
			);
		}

		it("lays a thumb along the pane's bottom edge, sized to the share it shows", () => {
			const el = makePane();

			scrollSidewaysTo(el, 400);

			expect(sidewaysThumbFor(el)?.style.width).toBe("40px");
		});

		it("names the thumb's axis, which the stylesheet sizes it by", () => {
			const el = makePane();

			scrollSidewaysTo(el, 400);

			expect(sidewaysThumbFor(el)?.dataset.axis).toBe("horizontal");
		});

		it("places the thumb as far along the edge as the pane has scrolled", () => {
			const el = makePane();

			scrollSidewaysTo(el, 400);

			expect(sidewaysThumbFor(el)?.style.left).toBe("90px");
		});

		it.each([
			{ name: "nothing to scroll", overflow: 0 },
			{ name: "a rounding artifact", overflow: 1 },
			{ name: "exactly the ignored maximum", overflow: 2 },
		])("ignores a sideways range of $name", ({ overflow }) => {
			const el = makePane({ scrollWidth: 200 + overflow, clientWidth: 200 });

			scrollSidewaysTo(el, overflow);

			expect(sidewaysThumbFor(el)).toBeNull();
		});

		// The column header mirrors the commit list's offset this way: it moves
		// only because its scrollLeft is written, so a thumb there would be a
		// second thumb for one scroll.
		it("gives no thumb to a pane the user cannot scroll sideways", () => {
			const el = makePane({ overflowX: "hidden" });

			scrollSidewaysTo(el, 400);

			expect(sidewaysThumbFor(el)).toBeNull();
		});

		it("gives no sideways thumb while only the vertical position moves", () => {
			const el = makePane({ scrollHeight: 1000, clientHeight: 200 });

			el.dispatchEvent(new Event("scroll"));

			expect(sidewaysThumbFor(el)).toBeNull();
		});

		it("removes the thumb once scrolling stops", () => {
			const el = makePane();

			scrollSidewaysTo(el, 400);
			vi.advanceTimersByTime(PAST_LINGER_MS);

			expect(sidewaysThumbFor(el)).toBeNull();
		});

		it("scrolls the pane sideways in proportion to how far the thumb is dragged", () => {
			const el = makePane();
			scrollSidewaysTo(el, 100);

			sidewaysThumbFor(el)?.dispatchEvent(
				new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }),
			);
			window.dispatchEvent(
				new MouseEvent("pointermove", { bubbles: true, clientX: 180 }),
			);

			expect(el.scrollLeft).toBe(500);
		});
	});
});
