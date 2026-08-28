const REVEALED = "var(--color-scrollbar-thumb)";
const HIDDEN = "transparent";
const LINGER_MS = 900;
const IGNORED_RANGE_PX = 2;

const hideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function onScroll(event: Event) {
	const el = event.target;
	if (!(el instanceof HTMLElement)) return;
	if (el.scrollHeight - el.clientHeight <= IGNORED_RANGE_PX) return;

	el.style.setProperty("--scrollbar-thumb-paint", REVEALED);

	clearTimeout(hideTimers.get(el));
	hideTimers.set(
		el,
		setTimeout(
			() => el.style.setProperty("--scrollbar-thumb-paint", HIDDEN),
			LINGER_MS,
		),
	);
}

/** One capture-phase listener covers every scroller in the app, including ones
 *  added later: `scroll` doesn't bubble, but it does capture. */
export function trackScrollActivity(): () => void {
	document.addEventListener("scroll", onScroll, true);
	return () => document.removeEventListener("scroll", onScroll, true);
}
