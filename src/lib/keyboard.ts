/**
 * One reading of a keydown for every shortcut handler in the app.
 *
 * A chord is the held modifiers, in a fixed order, then the key: "j",
 * "Meta+j", "Meta+Shift+w", "Ctrl+Tab". Because the modifiers are part of the
 * chord, a handler bound to "j" cannot fire on Cmd+J, and a handler bound to
 * "Meta+j" cannot fire on a bare J. Single-character keys are lowercased so
 * Shift is carried by the modifier list rather than by the letter's case.
 * Symbols stay as the layout reports them, so Cmd+Shift+= arrives as
 * "Meta+Shift++" on a US layout.
 */
export function keyChord(e: KeyboardEvent): string {
	const held: string[] = [];
	if (e.metaKey) held.push("Meta");
	if (e.ctrlKey) held.push("Ctrl");
	if (e.altKey) held.push("Alt");
	if (e.shiftKey) held.push("Shift");

	if (isModifierName(e.key)) return held.join("+");
	return [...held, normalizeKey(e.key)].join("+");
}

const MODIFIER_NAMES = new Set(["Meta", "Control", "Alt", "Shift"]);

function isModifierName(key: string): boolean {
	return MODIFIER_NAMES.has(key);
}

function normalizeKey(key: string): string {
	return key.length === 1 ? key.toLowerCase() : key;
}

/** Whether the focused element consumes typing, so plain-key shortcuts must stand down. */
export function focusInEditable(active: Element | null): boolean {
	if (!(active instanceof HTMLElement)) return false;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement ||
		active instanceof HTMLSelectElement
	) {
		return true;
	}
	return (
		active.isContentEditable ||
		active.getAttribute("contenteditable") === "true"
	);
}
