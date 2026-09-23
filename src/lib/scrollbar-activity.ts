export const THUMB_CLASS = "scrollbar-overlay-thumb";
const LINGER_MS = 900;
const IGNORED_RANGE_PX = 2;
const THUMB_INSET_PX = 3;
const MIN_THUMB_LENGTH_PX = 24;

/** One axis of a scroller: where its track sits on screen and how far its
 *  content runs past what the pane shows. */
export interface ScrollAxisExtent {
	trackStart: number;
	trackLength: number;
	offset: number;
	scrollLength: number;
	clientLength: number;
}

// Geometry only, no DOM: the part a real browser layout can't help test.
export function thumbGeometry(axis: ScrollAxisExtent): {
	start: number;
	length: number;
} {
	const length = Math.max(
		MIN_THUMB_LENGTH_PX,
		axis.trackLength * (axis.clientLength / axis.scrollLength),
	);
	const maxOffset = axis.scrollLength - axis.clientLength;
	const travel = axis.trackLength - length;
	const start =
		axis.trackStart + (maxOffset > 0 ? (axis.offset / maxOffset) * travel : 0);

	return { start, length };
}

// The inverse of thumbGeometry: where a thumb dragged this far leaves the content.
export function dragScrollPosition(drag: {
	startOffset: number;
	pointerTravel: number;
	trackLength: number;
	thumbLength: number;
	scrollLength: number;
	clientLength: number;
}): number {
	const travel = drag.trackLength - drag.thumbLength;
	if (travel <= 0) return drag.startOffset;

	const maxOffset = drag.scrollLength - drag.clientLength;
	const moved = drag.startOffset + (drag.pointerTravel / travel) * maxOffset;

	return Math.min(Math.max(moved, 0), maxOffset);
}

/** How the thumb reads, draws and drives one axis of a scroller. */
interface ScrollAxis {
	name: "vertical" | "horizontal";
	extent(el: HTMLElement): ScrollAxisExtent;
	pointerCoordinate(event: PointerEvent): number;
	scrollTo(el: HTMLElement, offset: number): void;
	place(
		thumb: HTMLDivElement,
		el: HTMLElement,
		geometry: { start: number; length: number },
	): void;
}

const vertical: ScrollAxis = {
	name: "vertical",
	extent(el) {
		const rect = el.getBoundingClientRect();
		return {
			trackStart: rect.top,
			trackLength: rect.height,
			offset: el.scrollTop,
			scrollLength: el.scrollHeight,
			clientLength: el.clientHeight,
		};
	},
	pointerCoordinate: (event) => event.clientY,
	scrollTo(el, offset) {
		el.scrollTop = offset;
	},
	place(thumb, el, { start, length }) {
		const rect = el.getBoundingClientRect();

		thumb.style.top = `${start}px`;
		thumb.style.height = `${length}px`;
		thumb.style.right = `${window.innerWidth - rect.right + THUMB_INSET_PX}px`;
	},
};

const horizontal: ScrollAxis = {
	name: "horizontal",
	extent(el) {
		const rect = el.getBoundingClientRect();
		return {
			trackStart: rect.left,
			trackLength: rect.width,
			offset: el.scrollLeft,
			scrollLength: el.scrollWidth,
			clientLength: el.clientWidth,
		};
	},
	pointerCoordinate: (event) => event.clientX,
	scrollTo(el, offset) {
		el.scrollLeft = offset;
	},
	place(thumb, el, { start, length }) {
		const rect = el.getBoundingClientRect();

		thumb.style.left = `${start}px`;
		thumb.style.width = `${length}px`;
		thumb.style.bottom = `${window.innerHeight - rect.bottom + THUMB_INSET_PX}px`;
	},
};

/** Whether the user can scroll this pane sideways, rather than only a script. */
function scrollsSideways(el: HTMLElement): boolean {
	const { overflowX } = getComputedStyle(el);
	return overflowX === "auto" || overflowX === "scroll";
}

/** One capture-phase listener covers every scroller in the app, including ones
 *  added later: `scroll` doesn't bubble, but it does capture.
 *
 *  The native scrollbar is hidden everywhere (`::-webkit-scrollbar { display:
 *  none }` in app.css) rather than styled: WebKit and Blink both drop overlay
 *  scrollbars the moment any `::-webkit-scrollbar*` rule targets an element,
 *  and the declared width becomes both the thumb's paint width and a
 *  permanently reserved layout gutter, on every axis, with no way to get one
 *  without the other (measured directly: `display: none` is the only setting
 *  that reserves nothing, and native scrolling — wheel, trackpad, keyboard,
 *  `scrollTop` — keeps working with no visible chrome at all). This paints a
 *  themed thumb instead as a `position: fixed` element appended to `<body>`
 *  and positioned from `getBoundingClientRect()`, the same technique
 *  `tooltip.ts` already uses for its popup: it never joins the scroller's own
 *  box, so it can never affect that box's layout. This is the established
 *  mechanism behind Radix UI's ScrollArea and the OverlayScrollbars library:
 *  real native scroll, native chrome hidden, a separate overlay thumb kept in
 *  sync. */
export function trackScrollActivity(): () => void {
	const hideTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
	const thumbs = new Map<HTMLElement, Map<ScrollAxis, HTMLDivElement>>();
	const lastScrollLeft = new WeakMap<HTMLElement, number>();
	let drag: {
		el: HTMLElement;
		axis: ScrollAxis;
		startPointer: number;
		startOffset: number;
		trackLength: number;
		thumbLength: number;
	} | null = null;

	function paint(el: HTMLElement, axis: ScrollAxis) {
		let painted = thumbs.get(el);
		if (!painted) {
			painted = new Map();
			thumbs.set(el, painted);
		}

		let thumb = painted.get(axis);
		if (!thumb) {
			thumb = document.createElement("div");
			thumb.className = THUMB_CLASS;
			thumb.dataset.axis = axis.name;
			thumb.addEventListener("pointerdown", (event) => grab(event, el, axis));
			// Without these the linger timer runs out under a cursor that is
			// resting on the thumb, and the thumb vanishes as it is reached for.
			thumb.addEventListener("pointerenter", () => hold(el));
			thumb.addEventListener("pointerleave", () => settle(el));
			document.body.appendChild(thumb);
			painted.set(axis, thumb);
		}

		axis.place(thumb, el, thumbGeometry(axis.extent(el)));
	}

	function hold(el: HTMLElement) {
		clearTimeout(hideTimers.get(el));
		hideTimers.delete(el);
	}

	function fade(el: HTMLElement) {
		hold(el);
		hideTimers.set(
			el,
			setTimeout(() => {
				for (const thumb of thumbs.get(el)?.values() ?? []) thumb.remove();
				thumbs.delete(el);
				hideTimers.delete(el);
			}, LINGER_MS),
		);
	}

	function settle(el: HTMLElement) {
		if (drag?.el === el) hold(el);
		else fade(el);
	}

	function grab(event: PointerEvent, el: HTMLElement, axis: ScrollAxis) {
		const extent = axis.extent(el);

		drag = {
			el,
			axis,
			startPointer: axis.pointerCoordinate(event),
			startOffset: extent.offset,
			trackLength: extent.trackLength,
			thumbLength: thumbGeometry(extent).length,
		};

		hold(el);
		event.preventDefault();
	}

	function onScroll(event: Event) {
		const el = event.target;
		if (!(el instanceof HTMLElement)) return;

		// A pane with some incidental sideways overflow shows no sideways thumb
		// while it scrolls up and down; only a sideways scroll brings one.
		const movedSideways = el.scrollLeft !== (lastScrollLeft.get(el) ?? 0);
		lastScrollLeft.set(el, el.scrollLeft);

		const showsVertical = el.scrollHeight - el.clientHeight > IGNORED_RANGE_PX;
		const showsHorizontal =
			movedSideways &&
			el.scrollWidth - el.clientWidth > IGNORED_RANGE_PX &&
			scrollsSideways(el);
		if (!showsVertical && !showsHorizontal) return;

		if (showsVertical) paint(el, vertical);
		if (showsHorizontal) paint(el, horizontal);
		settle(el);
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag) return;

		const { el, axis } = drag;
		const extent = axis.extent(el);

		axis.scrollTo(
			el,
			dragScrollPosition({
				startOffset: drag.startOffset,
				pointerTravel: axis.pointerCoordinate(event) - drag.startPointer,
				trackLength: drag.trackLength,
				thumbLength: drag.thumbLength,
				scrollLength: extent.scrollLength,
				clientLength: extent.clientLength,
			}),
		);
		paint(el, axis);
	}

	function onPointerUp() {
		if (!drag) return;

		const { el } = drag;
		drag = null;
		settle(el);
	}

	document.addEventListener("scroll", onScroll, true);
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", onPointerUp);

	return () => {
		document.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", onPointerUp);
		window.removeEventListener("pointercancel", onPointerUp);

		for (const timer of hideTimers.values()) clearTimeout(timer);
		hideTimers.clear();
		for (const painted of thumbs.values()) {
			for (const thumb of painted.values()) thumb.remove();
		}
		thumbs.clear();
		drag = null;
	};
}
