export const THUMB_CLASS = "scrollbar-overlay-thumb";
const LINGER_MS = 900;
const IGNORED_RANGE_PX = 2;
const THUMB_INSET_PX = 3;
// Matches the transparent side borders .scrollbar-overlay-thumb grabs with, so
// the painted sliver still lands THUMB_INSET_PX from the scroller's edge.
const THUMB_GRAB_PADDING_PX = 5;
const MIN_THUMB_HEIGHT_PX = 24;

// Geometry only, no DOM: the part a real browser layout can't help test.
export function thumbGeometry(
	trackTop: number,
	trackHeight: number,
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
): { top: number; height: number } {
	const height = Math.max(
		MIN_THUMB_HEIGHT_PX,
		trackHeight * (clientHeight / scrollHeight),
	);
	const maxScrollTop = scrollHeight - clientHeight;
	const travel = trackHeight - height;
	const top =
		trackTop + (maxScrollTop > 0 ? (scrollTop / maxScrollTop) * travel : 0);
	return { top, height };
}

// The inverse of thumbGeometry: where a thumb dragged this far leaves the content.
export function dragScrollTop(drag: {
	startScrollTop: number;
	deltaY: number;
	trackHeight: number;
	thumbHeight: number;
	scrollHeight: number;
	clientHeight: number;
}): number {
	const travel = drag.trackHeight - drag.thumbHeight;
	if (travel <= 0) return drag.startScrollTop;

	const maxScrollTop = drag.scrollHeight - drag.clientHeight;
	const moved = drag.startScrollTop + (drag.deltaY / travel) * maxScrollTop;

	return Math.min(Math.max(moved, 0), maxScrollTop);
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
	const thumbs = new Map<HTMLElement, HTMLDivElement>();
	const owners = new WeakMap<HTMLElement, HTMLElement>();
	let hovered: HTMLElement | null = null;
	let drag: {
		el: HTMLElement;
		startY: number;
		startScrollTop: number;
		trackHeight: number;
		thumbHeight: number;
	} | null = null;

	// Starts at Element, not HTMLElement: the commit graph's overlay is SVG, and
	// an SVGElement is neither, so anchoring the walk on HTMLElement would make
	// the whole graph pane unhoverable.
	function scrollerAt(node: EventTarget | null): HTMLElement | null {
		let el = node instanceof Element ? node : null;
		while (el) {
			if (
				el instanceof HTMLElement &&
				el.scrollHeight - el.clientHeight > IGNORED_RANGE_PX
			) {
				const { overflowY } = getComputedStyle(el);
				if (overflowY === "auto" || overflowY === "scroll") return el;
			}
			el = el.parentElement;
		}
		return null;
	}

	// The thumb is a body-level overlay, so crossing onto it leaves the pane as
	// far as the DOM is concerned. Both are the same scroller to the reveal.
	function paneOf(node: EventTarget | null): HTMLElement | null {
		if (node instanceof HTMLElement) {
			const owner = owners.get(node);
			if (owner) return owner;
		}
		return scrollerAt(node);
	}

	function stillWithin(el: HTMLElement, node: EventTarget | null): boolean {
		if (!(node instanceof Node)) return false;
		return el.contains(node) || thumbs.get(el) === node;
	}

	function paint(el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		const { top, height } = thumbGeometry(
			rect.top,
			rect.height,
			el.scrollTop,
			el.scrollHeight,
			el.clientHeight,
		);

		let thumb = thumbs.get(el);
		if (!thumb) {
			thumb = document.createElement("div");
			thumb.className = THUMB_CLASS;
			thumb.addEventListener("pointerdown", (event) => grab(event, el));
			document.body.appendChild(thumb);
			thumbs.set(el, thumb);
			owners.set(thumb, el);
		}

		thumb.style.top = `${top}px`;
		thumb.style.height = `${height}px`;
		thumb.style.right = `${window.innerWidth - rect.right + THUMB_INSET_PX - THUMB_GRAB_PADDING_PX}px`;
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
		if (drag?.el === el || hovered === el) hold(el);
		else fade(el);
	}

	function grab(event: PointerEvent, el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		const { height } = thumbGeometry(
			rect.top,
			rect.height,
			el.scrollTop,
			el.scrollHeight,
			el.clientHeight,
		);

		drag = {
			el,
			startY: event.clientY,
			startScrollTop: el.scrollTop,
			trackHeight: rect.height,
			thumbHeight: height,
		};

		hold(el);
		event.preventDefault();
	}

	function onScroll(event: Event) {
		const el = event.target;
		if (!(el instanceof HTMLElement)) return;
		if (el.scrollHeight - el.clientHeight <= IGNORED_RANGE_PX) return;

		paint(el);
		settle(el);
	}

	function onPointerOver(event: PointerEvent) {
		const el = paneOf(event.target);
		if (!el) return;

		hovered = el;
		paint(el);
		hold(el);
	}

	function onPointerOut(event: PointerEvent) {
		const el = paneOf(event.target);
		if (!el) return;
		if (stillWithin(el, event.relatedTarget)) return;

		if (hovered === el) hovered = null;
		settle(el);
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag) return;

		drag.el.scrollTop = dragScrollTop({
			startScrollTop: drag.startScrollTop,
			deltaY: event.clientY - drag.startY,
			trackHeight: drag.trackHeight,
			thumbHeight: drag.thumbHeight,
			scrollHeight: drag.el.scrollHeight,
			clientHeight: drag.el.clientHeight,
		});
		paint(drag.el);
	}

	function onPointerUp() {
		if (!drag) return;

		const { el } = drag;
		drag = null;
		settle(el);
	}

	document.addEventListener("scroll", onScroll, true);
	document.addEventListener("pointerover", onPointerOver, true);
	document.addEventListener("pointerout", onPointerOut, true);
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", onPointerUp);

	return () => {
		document.removeEventListener("scroll", onScroll, true);
		document.removeEventListener("pointerover", onPointerOver, true);
		document.removeEventListener("pointerout", onPointerOut, true);
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", onPointerUp);
		window.removeEventListener("pointercancel", onPointerUp);

		for (const timer of hideTimers.values()) clearTimeout(timer);
		hideTimers.clear();
		for (const thumb of thumbs.values()) thumb.remove();
		thumbs.clear();
		hovered = null;
		drag = null;
	};
}
