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
	ASIDE: "complementary",
	NAV: "navigation",
	MAIN: "main",
	DIALOG: "dialog",
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
		const text = collapse(announcedText(element));
		if (text) return text;
	}

	return collapse(element.getAttribute("title"));
}

/** The text under `node` a screen reader reads out, which leaves out every
 *  subtree marked hidden or aria-hidden, such as an avatar's initials. */
function announcedText(node: Node): string {
	if (node instanceof Element && isHiddenItself(node)) return "";
	if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";

	return [...node.childNodes].map(announcedText).join("");
}

function isHiddenItself(element: Element): boolean {
	return (
		element.hasAttribute("hidden") ||
		element.getAttribute("aria-hidden") === "true" ||
		getComputedStyle(element).display === "none"
	);
}

function isShown(element: Element): boolean {
	if (getComputedStyle(element).visibility === "hidden") return false;

	for (let node: Element | null = element; node; node = node.parentElement) {
		if (isHiddenItself(node)) return false;
	}
	return true;
}

function shownWithRole(role: string, root: Element = document.body): Element[] {
	return [...root.querySelectorAll("*")].filter(
		(element) => roleOf(element) === role && isShown(element),
	);
}

/** The one shown element with the landmark role `within`, or null while there
 *  is none. */
function landmark(within: string): Element | null {
	const landmarks = shownWithRole(within);
	if (landmarks.length > 1) {
		throw new AmbiguousControl(
			`${landmarks.length} shown ${within}s to look within`,
		);
	}
	return landmarks[0] ?? null;
}

/**
 * The one shown control with `role` named `name`, or null while there is none.
 * A name the page shows twice is told apart by `within`, the role of the one
 * landmark to look inside, as `complementary` for the branch sidebar.
 */
export function findByRole(
	role: string,
	name: string,
	within?: string,
): HTMLElement | null {
	const root = within ? landmark(within) : document.body;
	if (!root) return null;

	const matches = shownWithRole(role, root).filter(
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

/**
 * The first truthy value `read` returns, re-read after each change to the DOM.
 * It gives up after `deadlineMs`, naming what it `awaited`.
 */
export function waitFor<T>(
	awaited: string,
	read: () => T | null | undefined | false,
	deadlineMs: number,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const observer = new MutationObserver(check);
		const timer = setTimeout(() => {
			observer.disconnect();
			reject(new Error(`waited ${deadlineMs}ms for ${awaited}`));
		}, deadlineMs);
		function check() {
			let value: ReturnType<typeof read>;
			try {
				value = read();
			} catch (error) {
				observer.disconnect();
				clearTimeout(timer);
				reject(error);
				return;
			}
			if (!value) return;

			observer.disconnect();
			clearTimeout(timer);
			resolve(value);
		}

		observer.observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
		check();
	});
}

/** The control a user would operate, once it shows and is enabled. */
export function control(
	role: string,
	name: string,
	deadlineMs: number,
	within?: string,
): Promise<HTMLElement> {
	const where = within ? ` within the ${within}` : "";
	return waitFor(
		`an enabled ${role} named "${name}"${where}`,
		() => {
			const found = findByRole(role, name, within);
			return found && isEnabled(found) ? found : null;
		},
		deadlineMs,
	);
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

/** Clicks with the secondary button, which is how a user opens a control's
 *  context menu. */
export function rightClick(element: HTMLElement): void {
	const pointer = { bubbles: true, cancelable: true, button: 2 };

	element.dispatchEvent(new PointerEvent("pointerdown", pointer));
	element.dispatchEvent(new MouseEvent("mousedown", pointer));
	element.dispatchEvent(new MouseEvent("contextmenu", pointer));
	element.dispatchEvent(new PointerEvent("pointerup", pointer));
	element.dispatchEvent(new MouseEvent("mouseup", pointer));
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
	const [, held, key] = /^(?:(.*)\+)?(.+)$/.exec(combo) ?? [];
	if (!key) throw new Error("name a key to press");
	const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
	const parts = held ? held.split("+") : [];
	for (const modifier of parts) {
		const flag = MODIFIERS[modifier];
		if (!flag) throw new Error(`"${modifier}" is not a modifier`);
		init[flag] = true;
	}
	const target = document.activeElement ?? document.body;

	target.dispatchEvent(new KeyboardEvent("keydown", init));
	target.dispatchEvent(new KeyboardEvent("keyup", init));
}
