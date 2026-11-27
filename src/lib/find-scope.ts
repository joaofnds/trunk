import { on } from "svelte/events";
import { focusInEditable, keyChord, keyInDialog } from "./keyboard.js";

// The native Find event has no DOM target. Read the focused element at dispatch
// time so moving between panes also moves Find, without tracking a second focus.
const scopes = new WeakMap<Element, () => void>();

export function findScope(open: () => void, dismiss?: () => boolean) {
	return (node: HTMLElement) => {
		scopes.set(node, open);
		const off =
			dismiss &&
			on(node, "keydown", (event) => {
				if (
					event.defaultPrevented ||
					event.isComposing ||
					keyChord(event) !== "Escape"
				)
					return;
				if (
					keyInDialog(event) ||
					focusInEditable(node.ownerDocument.activeElement)
				)
					return;
				if (dismiss()) event.preventDefault();
			});
		return () => {
			scopes.delete(node);
			off?.();
		};
	};
}

export function openFocusedFind(within: HTMLElement): boolean {
	let node = within.ownerDocument.activeElement;
	if (!node || !within.contains(node)) return false;

	while (node) {
		const open = scopes.get(node);
		if (open) {
			open();
			return true;
		}
		if (node === within) break;
		node = node.parentElement;
	}
	return false;
}
