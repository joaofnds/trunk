// Native `title` has a browser-fixed ~500ms appearance delay no API can shorten.
// This action renders a custom tooltip that appears after SHOW_DELAY_MS, centered
// on its trigger and placed above it when the space below runs out.
// `aria-label` on the trigger remains the accessible name; this is visual only.

import { textOverrun } from "./text-overrun.js";

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

type TooltipHandle = { update(next: string): void; destroy(): void };

export function tooltip(node: HTMLElement, text: string): TooltipHandle {
	return attachTooltip(node, text, () => true);
}

/** A tooltip carrying a cell's full text, shown only while the cell cuts it. */
export function cutTooltip(node: HTMLElement, text: string): TooltipHandle {
	return attachTooltip(node, text, () => textOverrun(node) > 0);
}

function attachTooltip(
	node: HTMLElement,
	text: string,
	isWanted: () => boolean,
): TooltipHandle {
	let label = text;
	let el: HTMLDivElement | null = null;
	let ready = false;
	let showTimer: ReturnType<typeof setTimeout> | undefined;

	function place() {
		if (!el) return;

		const rect = node.getBoundingClientRect();
		const below = window.innerHeight - VIEWPORT_MARGIN - rect.bottom;
		const above = rect.top - VIEWPORT_MARGIN;
		el.style.maxHeight = "";
		const height = el.offsetHeight;
		const openBelow =
			height + TRIGGER_GAP <= below ||
			(height + TRIGGER_GAP > above && below >= above);
		const available = openBelow ? below : above;
		const scrollable = height + TRIGGER_GAP > available;
		el.classList.toggle("tooltip-pop-scrollable", scrollable);
		if (scrollable) el.style.maxHeight = `${Math.max(0, available)}px`;
		// A scrollable report touches the trigger so the pointer can enter it.
		const gap = scrollable ? 0 : TRIGGER_GAP;
		el.style.left = `${clampedLeft(rect, el.offsetWidth, window.innerWidth)}px`;
		el.style.top = `${openBelow ? rect.bottom + gap : rect.top - gap - el.offsetHeight}px`;
	}

	function renderLabel(element: HTMLDivElement) {
		if (element.textContent !== label) element.textContent = label;
		element.classList.toggle("tooltip-pop-multiline", label.includes("\n"));
	}

	function removePopup() {
		el?.remove();
		el = null;
	}

	function refresh() {
		if (!ready) return;

		if (!label.trim() || !isWanted()) {
			removePopup();
			return;
		}

		if (!el) {
			el = document.createElement("div");
			el.className = "tooltip-pop";
			el.addEventListener("mouseleave", leave);
			document.body.appendChild(el);
			requestAnimationFrame(() => el?.classList.add("tooltip-pop-shown"));
		}
		renderLabel(el);
		place();
	}

	function scheduleShow() {
		clearTimeout(showTimer);
		showTimer = setTimeout(() => {
			ready = true;
			window.addEventListener("resize", refresh);
			refresh();
		}, SHOW_DELAY_MS);
	}

	function hide() {
		clearTimeout(showTimer);
		ready = false;
		window.removeEventListener("resize", refresh);
		removePopup();
	}

	function leave(event: MouseEvent) {
		const next = event.relatedTarget;
		if (
			el?.classList.contains("tooltip-pop-scrollable") &&
			next instanceof Node &&
			(el.contains(next) || node.contains(next))
		) {
			return;
		}

		hide();
	}

	function readReport(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		if (
			document.activeElement !== node ||
			!el?.classList.contains("tooltip-pop-scrollable")
		)
			return;
		if (event.key === "PageDown" || event.key === "PageUp") {
			el.scrollTop +=
				event.key === "PageDown" ? el.clientHeight : -el.clientHeight;
		} else if (event.key === "Escape") {
			hide();
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	node.addEventListener("mouseenter", scheduleShow);
	node.addEventListener("mouseleave", leave);
	node.addEventListener("focus", scheduleShow);
	node.addEventListener("blur", hide);
	node.addEventListener("click", hide);
	node.addEventListener("keydown", readReport);

	return {
		update(next: string) {
			label = next;
			refresh();
		},
		destroy() {
			hide();
			node.removeEventListener("mouseenter", scheduleShow);
			node.removeEventListener("mouseleave", leave);
			node.removeEventListener("focus", scheduleShow);
			node.removeEventListener("blur", hide);
			node.removeEventListener("click", hide);
			node.removeEventListener("keydown", readReport);
		},
	};
}
