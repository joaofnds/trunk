const REVEALED = "var(--color-scrollbar-thumb)";
const HIDDEN = "transparent";
const LINGER_MS = 900;
const MIN_SCROLLABLE_PX = 2;

const hideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function onScroll(event: Event) {
	const el = event.target;
	if (!(el instanceof HTMLElement)) return;
	if (el.scrollHeight - el.clientHeight <= MIN_SCROLLABLE_PX) return;

	el.style.setProperty("--scrollbar-thumb", REVEALED);

	clearTimeout(hideTimers.get(el));
	hideTimers.set(
		el,
		setTimeout(
			() => el.style.setProperty("--scrollbar-thumb", HIDDEN),
			LINGER_MS,
		),
	);
}

/**
 * Shows a scroller's thumb while it scrolls and hides it once it stops, the way
 * a native macOS overlay scrollbar behaves.
 *
 * The reveal has to travel through a CSS custom property on the scroller.
 * WebKit resolves `::-webkit-scrollbar-*` rules once and never re-matches them
 * when the owner's class or `:hover` state changes, so a CSS-only reveal paints
 * only when something else happens to invalidate the scrollbar. A custom
 * property does propagate to the live scrollbar.
 *
 * One capture-phase listener covers every scroller in the app, including ones
 * added later: `scroll` doesn't bubble, but it does capture.
 */
export function trackScrollActivity(root: Document = document): () => void {
	root.addEventListener("scroll", onScroll, true);
	return () => root.removeEventListener("scroll", onScroll, true);
}
