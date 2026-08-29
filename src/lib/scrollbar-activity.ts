export const THUMB_CLASS = "scrollbar-overlay-thumb";
const LINGER_MS = 900;
const IGNORED_RANGE_PX = 2;
const THUMB_INSET_PX = 3;
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

	function onScroll(event: Event) {
		const el = event.target;
		if (!(el instanceof HTMLElement)) return;
		if (el.scrollHeight - el.clientHeight <= IGNORED_RANGE_PX) return;

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
			document.body.appendChild(thumb);
			thumbs.set(el, thumb);
		}
		thumb.style.top = `${top}px`;
		thumb.style.height = `${height}px`;
		thumb.style.right = `${window.innerWidth - rect.right + THUMB_INSET_PX}px`;

		clearTimeout(hideTimers.get(el));
		hideTimers.set(
			el,
			setTimeout(() => {
				thumbs.get(el)?.remove();
				thumbs.delete(el);
				hideTimers.delete(el);
			}, LINGER_MS),
		);
	}

	document.addEventListener("scroll", onScroll, true);

	return () => {
		document.removeEventListener("scroll", onScroll, true);
		for (const timer of hideTimers.values()) clearTimeout(timer);
		hideTimers.clear();
		for (const thumb of thumbs.values()) thumb.remove();
		thumbs.clear();
	};
}
