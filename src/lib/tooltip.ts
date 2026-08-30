// Native `title` has a browser-fixed ~500ms appearance delay no API can shorten.
// This action renders a custom tooltip that appears after SHOW_DELAY_MS, centered
// under its trigger and clamped to the viewport so it never spills off-screen.
// `aria-label` on the trigger remains the accessible name; this is visual only.

export const SHOW_DELAY_MS = 300;
const VIEWPORT_MARGIN = 6;
const TRIGGER_GAP = 6;

// Horizontal position that centers a `tooltipWidth`-wide tooltip under a trigger,
// clamped so it never crosses either viewport edge (within `margin`). Pure so the
// edge math — the part that overflowed off-screen — is unit-testable on its own.
export function clampedLeft(
	triggerRect: { left: number; width: number },
	tooltipWidth: number,
	viewportWidth: number,
	margin = VIEWPORT_MARGIN,
): number {
	const centered = triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2;
	const maxLeft = viewportWidth - tooltipWidth - margin;
	return Math.max(margin, Math.min(centered, maxLeft));
}

export function tooltip(
	node: HTMLElement,
	text: string,
): { update(next: string): void; destroy(): void } {
	let label = text;
	let el: HTMLDivElement | null = null;
	let showTimer: ReturnType<typeof setTimeout> | undefined;

	function place() {
		if (!el) return;
		const rect = node.getBoundingClientRect();
		el.style.left = `${clampedLeft(rect, el.offsetWidth, window.innerWidth)}px`;
		el.style.top = `${rect.bottom + TRIGGER_GAP}px`;
	}

	function show() {
		// Skip blank labels so a trigger with no text (e.g. a not-yet-computed
		// value) never flashes an empty popup.
		if (el || !label.trim()) return;
		el = document.createElement("div");
		el.className = "tooltip-pop";
		el.textContent = label;
		document.body.appendChild(el);
		place();
		requestAnimationFrame(() => el?.classList.add("tooltip-pop-shown"));
	}

	function scheduleShow() {
		clearTimeout(showTimer);
		showTimer = setTimeout(show, SHOW_DELAY_MS);
	}

	function hide() {
		clearTimeout(showTimer);
		el?.remove();
		el = null;
	}

	node.addEventListener("mouseenter", scheduleShow);
	node.addEventListener("mouseleave", hide);
	node.addEventListener("focus", scheduleShow);
	node.addEventListener("blur", hide);
	node.addEventListener("click", hide);

	return {
		update(next: string) {
			label = next;
			if (!el) return;
			if (next.trim()) el.textContent = next;
			else hide();
		},
		destroy() {
			hide();
			node.removeEventListener("mouseenter", scheduleShow);
			node.removeEventListener("mouseleave", hide);
			node.removeEventListener("focus", scheduleShow);
			node.removeEventListener("blur", hide);
			node.removeEventListener("click", hide);
		},
	};
}
