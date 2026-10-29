/**
 * How the drive route (src/drive.ts) finds a control: by its role and the name
 * a user reads on it, the way a screen reader does, so an agent addresses the
 * interface by what it shows and never by its markup.
 */

/** More than one shown control answers to the role and name asked for. */
export class AmbiguousControl extends Error {}

const IMPLICIT_ROLES: Record<string, string> = {
	BUTTON: "button",
	TEXTAREA: "textbox",
	SELECT: "combobox",
	OPTION: "option",
	LI: "listitem",
	H1: "heading",
	H2: "heading",
	H3: "heading",
	H4: "heading",
	H5: "heading",
	H6: "heading",
};

const INPUT_ROLES: Record<string, string> = {
	button: "button",
	submit: "button",
	reset: "button",
	checkbox: "checkbox",
	radio: "radio",
	text: "textbox",
	search: "searchbox",
	email: "textbox",
	url: "textbox",
	tel: "textbox",
};

function roleOf(element: Element): string | null {
	const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
	if (explicit) return explicit;

	if (element instanceof HTMLInputElement) {
		return INPUT_ROLES[element.type] ?? null;
	}
	if (element instanceof HTMLAnchorElement) {
		return element.hasAttribute("href") ? "link" : null;
	}
	return IMPLICIT_ROLES[element.tagName] ?? null;
}

function collapse(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

function isField(
	element: Element,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
	return (
		element instanceof HTMLInputElement ||
		element instanceof HTMLTextAreaElement ||
		element instanceof HTMLSelectElement
	);
}

/** The accessible name, by the steps of accname 1.2 a Trunk control uses:
 *  aria-labelledby, aria-label, a field's label or placeholder, the element's
 *  own text, then its title. */
export function nameOf(element: Element): string {
	const labelledBy = element.getAttribute("aria-labelledby");
	if (labelledBy) {
		return collapse(
			labelledBy
				.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent ?? "")
				.join(" "),
		);
	}

	const label = collapse(element.getAttribute("aria-label"));
	if (label) return label;

	if (isField(element)) {
		const labels = collapse(
			[...(element.labels ?? [])].map((l) => l.textContent).join(" "),
		);
		if (labels) return labels;
		const placeholder = collapse(element.getAttribute("placeholder"));
		if (placeholder) return placeholder;
	} else {
		const text = collapse(element.textContent);
		if (text) return text;
	}

	return collapse(element.getAttribute("title"));
}

function isShown(element: Element): boolean {
	if (getComputedStyle(element).visibility === "hidden") return false;

	for (let node: Element | null = element; node; node = node.parentElement) {
		if (node.hasAttribute("hidden")) return false;
		if (node.getAttribute("aria-hidden") === "true") return false;
		if (getComputedStyle(node).display === "none") return false;
	}
	return true;
}

function shownWithRole(role: string): Element[] {
	return [...document.body.querySelectorAll("*")].filter(
		(element) => roleOf(element) === role && isShown(element),
	);
}

/** The one shown control with `role` named `name`, or null while there is none. */
export function findByRole(role: string, name: string): HTMLElement | null {
	const matches = shownWithRole(role).filter(
		(element) => nameOf(element) === name,
	);

	if (matches.length > 1) {
		throw new AmbiguousControl(
			`${matches.length} shown ${role}s are named "${name}"`,
		);
	}
	const [match] = matches;
	return match instanceof HTMLElement ? match : null;
}

/** The names of every shown element with `role`, in page order. */
export function namesOf(role: string): string[] {
	return shownWithRole(role).map(nameOf);
}

/** Whether a user could operate the control: not disabled, by itself or a
 *  disabled fieldset, and not marked aria-disabled. */
export function isEnabled(element: HTMLElement): boolean {
	if (element.matches(":disabled")) return false;

	return element.closest('[aria-disabled="true"]') === null;
}

/** Clicks the way a pointer does, so a handler on any of the steps fires. */
export function click(element: HTMLElement): void {
	const pointer = { bubbles: true, cancelable: true, button: 0 };

	element.dispatchEvent(new PointerEvent("pointerdown", pointer));
	element.dispatchEvent(new MouseEvent("mousedown", pointer));
	element.focus();
	element.dispatchEvent(new PointerEvent("pointerup", pointer));
	element.dispatchEvent(new MouseEvent("mouseup", pointer));
	element.dispatchEvent(new MouseEvent("click", pointer));
}

/** Types `text` at the end of a field, as one input event the way a paste
 *  arrives, which is what a bound value listens for. */
export function typeInto(
	field: HTMLInputElement | HTMLTextAreaElement,
	text: string,
): void {
	field.focus();
	field.value += text;
	field.dispatchEvent(
		new InputEvent("input", {
			bubbles: true,
			inputType: "insertText",
			data: text,
		}),
	);
}

const MODIFIERS: Record<string, "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> =
	{
		Meta: "metaKey",
		Cmd: "metaKey",
		Control: "ctrlKey",
		Ctrl: "ctrlKey",
		Alt: "altKey",
		Option: "altKey",
		Shift: "shiftKey",
	};

/** Presses a key like "Escape" or "Meta+Enter" on the focused element. */
export function pressKey(combo: string): void {
	const parts = combo.split("+");
	const key = parts.pop() ?? "";
	const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
	for (const modifier of parts) {
		const flag = MODIFIERS[modifier];
		if (!flag) throw new Error(`"${modifier}" is not a modifier`);
		init[flag] = true;
	}
	const target = document.activeElement ?? document.body;

	target.dispatchEvent(new KeyboardEvent("keydown", init));
	target.dispatchEvent(new KeyboardEvent("keyup", init));
}
