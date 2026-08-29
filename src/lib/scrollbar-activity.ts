export const THUMB_PROPERTY = "--scrollbar-thumb-paint";
const REVEALED = "var(--color-scrollbar-thumb)";
const HIDDEN = "transparent";
const LINGER_MS = 900;
const IGNORED_RANGE_PX = 2;

/** One capture-phase listener covers every scroller in the app, including ones
 *  added later: `scroll` doesn't bubble, but it does capture. Timers live in
 *  this call's own closure, not module scope, so a second tracker can't steal
 *  the first one's teardown, and stop() can clear every timer it started. */
export function trackScrollActivity(): () => void {
	const hideTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

	function onScroll(event: Event) {
		const el = event.target;
		if (!(el instanceof HTMLElement)) return;
		if (el.scrollHeight - el.clientHeight <= IGNORED_RANGE_PX) return;

		el.style.setProperty(THUMB_PROPERTY, REVEALED);

		clearTimeout(hideTimers.get(el));
		hideTimers.set(
			el,
			setTimeout(() => {
				el.style.setProperty(THUMB_PROPERTY, HIDDEN);
				hideTimers.delete(el);
			}, LINGER_MS),
		);
	}

	document.addEventListener("scroll", onScroll, true);

	return () => {
		document.removeEventListener("scroll", onScroll, true);
		for (const timer of hideTimers.values()) clearTimeout(timer);
		hideTimers.clear();
	};
}
