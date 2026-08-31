import { waitFor } from "../harness/wait.js";

const SHOW_RENDERED = 'button[title="Show rendered markdown"]';
const ADDED_BLOCK = ".rendered-diff .md-added";
const REMOVED_BLOCK = ".rendered-diff .md-removed";

/** The center diff pane's markdown affordance: the source/rendered toggle and
 *  the tinted blocks the rendered view shows. */
export class DiffPaneDriver {
	/** Switches the pane from source to rendered markdown. */
	async showRendered(): Promise<void> {
		const button = await waitFor("the rendered-markdown toggle", () =>
			document.querySelector<HTMLButtonElement>(SHOW_RENDERED),
		);

		button.click();
	}

	/** The text of every green (added) rendered block, topmost first. */
	renderedAdded(): string[] {
		return textsOf(ADDED_BLOCK);
	}

	/** The text of every red (removed) rendered block, topmost first. */
	renderedRemoved(): string[] {
		return textsOf(REMOVED_BLOCK);
	}
}

function textsOf(selector: string): string[] {
	const blocks = document.querySelectorAll<HTMLElement>(selector);

	return [...blocks].map((block) => block.textContent?.trim() ?? "");
}
