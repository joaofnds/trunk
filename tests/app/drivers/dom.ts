import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";

/** The first element matching `selector` whose text satisfies `matches`, or null
 *  while the interface is not showing one. Every driver locates its target by
 *  what the user reads on it. */
export function firstMatching(
	selector: string,
	matches: (text: string) => boolean,
): HTMLElement | null {
	const candidates = document.querySelectorAll<HTMLElement>(selector);
	for (const candidate of candidates) {
		if (matches(candidate.textContent?.trim() ?? "")) return candidate;
	}
	return null;
}

/** The button reading exactly `label`, or null while it is absent or
 *  disabled — jsdom dispatches no click on a disabled button. */
export function enabledButton(label: string): HTMLButtonElement | null {
	const button = firstMatching("button", (text) => text === label);
	if (!(button instanceof HTMLButtonElement)) return null;

	return button.disabled ? null : button;
}

/** Waits out a button's enabled gate and clicks it. */
export async function pressButton(label: string): Promise<void> {
	const button = await waitFor(`an enabled ${label} button`, () =>
		enabledButton(label),
	);

	button.click();
}

/**
 * Right-clicks `target` and returns once the menu it opens is showing. The
 * native menu never enters the DOM, so the Fake is the only thing that can say
 * the menu arrived; a gesture that dispatched and returned would race the
 * component's async menu build.
 */
export async function openContextMenu(
	target: Element,
	menu: FakeMenu,
	on: string,
): Promise<void> {
	target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

	await waitFor(`the context menu on ${on}`, () =>
		menu.items().length > 0 ? true : null,
	);
}
