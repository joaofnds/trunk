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
	scrolled: number;
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
	const maxScrolled = axis.scrollLength - axis.clientLength;
	const travel = axis.trackLength - length;
	const start =
		axis.trackStart +
		(maxScrolled > 0 ? (axis.scrolled / maxScrolled) * travel : 0);
	return { start, length };
}

// The inverse of thumbGeometry: where a thumb dragged this far leaves the content.
export function dragScrollPosition(drag: {
	startScrolled: number;
	pointerTravel: number;
	trackLength: number;
	thumbLength: number;
	scrollLength: number;
	clientLength: number;
}): number {
	const travel = drag.trackLength - drag.thumbLength;
	if (travel <= 0) return drag.startScrolled;

	const maxScrolled = drag.scrollLength - drag.clientLength;
	const moved =
		drag.startScrolled + (drag.pointerTravel / travel) * maxScrolled;

	return Math.min(Math.max(moved, 0), maxScrolled);
}

/** How the thumb reads, draws and drives one axis of a scroller. */
interface ScrollAxis {
	extent(el: HTMLElement): ScrollAxisExtent;
	pointer(event: PointerEvent): number;
	scrollTo(el: HTMLElement, scrolled: number): void;
	place(
		thumb: HTMLDivElement,
		el: HTMLElement,
		geometry: { start: number; length: number },
	): void;
}

const vertical: ScrollAxis = {
	extent(el) {
		const rect = el.getBoundingClientRect();
		return {
			trackStart: rect.top,
			trackLength: rect.height,
			scrolled: el.scrollTop,
			scrollLength: el.scrollHeight,
			clientLength: el.clientHeight,
		};
	},
	pointer: (event) => event.clientY,
	scrollTo(el, scrolled) {
		el.scrollTop = scrolled;
	},
	place(thumb, el, { start, length }) {
		const rect = el.getBoundingClientRect();

		thumb.style.top = `${start}px`;
		thumb.style.height = `${length}px`;
		thumb.style.right = `${window.innerWidth - rect.right + THUMB_INSET_PX}px`;
	},
};

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
	const thumbs = new Map<HTMLElement, HTMLDivElement>();
	let drag: {
		el: HTMLElement;
		axis: ScrollAxis;
		startPointer: number;
		startScrolled: number;
		trackLength: number;
		thumbLength: number;
	} | null = null;

	function paint(el: HTMLElement, axis: ScrollAxis) {
		let thumb = thumbs.get(el);
		if (!thumb) {
			thumb = document.createElement("div");
			thumb.className = THUMB_CLASS;
			thumb.addEventListener("pointerdown", (event) => grab(event, el, axis));
			// Without these the linger timer runs out under a cursor that is
			// resting on the thumb, and the thumb vanishes as it is reached for.
			thumb.addEventListener("pointerenter", () => hold(el));
			thumb.addEventListener("pointerleave", () => settle(el));
			document.body.appendChild(thumb);
			thumbs.set(el, thumb);
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
				thumbs.get(el)?.remove();
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
			startPointer: axis.pointer(event),
			startScrolled: extent.scrolled,
			trackLength: extent.trackLength,
			thumbLength: thumbGeometry(extent).length,
		};

		hold(el);
		event.preventDefault();
	}

	function onScroll(event: Event) {
		const el = event.target;
		if (!(el instanceof HTMLElement)) return;
		if (el.scrollHeight - el.clientHeight <= IGNORED_RANGE_PX) return;

		paint(el, vertical);
		settle(el);
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag) return;

		const { el, axis } = drag;
		const extent = axis.extent(el);

		axis.scrollTo(
			el,
			dragScrollPosition({
				startScrolled: drag.startScrolled,
				pointerTravel: axis.pointer(event) - drag.startPointer,
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
		for (const thumb of thumbs.values()) thumb.remove();
		thumbs.clear();
		drag = null;
	};
}
