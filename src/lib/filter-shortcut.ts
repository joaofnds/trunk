import { focusInEditable, keyInDialog } from "./keyboard.js";

/** The nearest filter owns slash only while its list owns the keyboard. */
export function filterShortcut(node: HTMLElement, focus: () => void) {
	function keydown(event: KeyboardEvent) {
		if (
			event.key !== "/" ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.isComposing ||
			event.defaultPrevented ||
			focusInEditable(event.target instanceof Element ? event.target : null) ||
			keyInDialog(event)
		)
			return;

		event.preventDefault();
		focus();
	}
	node.addEventListener("keydown", keydown);
	return {
		destroy() {
			node.removeEventListener("keydown", keydown);
		},
	};
}
