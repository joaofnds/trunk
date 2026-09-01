import { waitFor } from "../harness/wait.js";

const SHOW_RENDERED = 'button[title="Show rendered markdown"]';
const SHOW_FULL_FILE = 'button[title="Show full file"]';
const IGNORE_WHITESPACE = 'button[title="Ignore whitespace changes"]';
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

	/** Switches the pane from hunk mode to the whole file. */
	async showFullFile(): Promise<void> {
		const button = await waitFor("the full-file toggle", () =>
			document.querySelector<HTMLButtonElement>(SHOW_FULL_FILE),
		);

		button.click();
	}

	/** Flips the ignore-whitespace toggle. The view then hides whitespace-only
	 *  hunks, which is what makes a hunk's position in the view differ from its
	 *  position in a diff built without the option. */
	async toggleIgnoreWhitespace(): Promise<void> {
		const button = await waitFor("the ignore-whitespace toggle", () =>
			document.querySelector<HTMLButtonElement>(IGNORE_WHITESPACE),
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

	/** The text of every del word mark in the rendered view, topmost first. */
	renderedWordDeleted(): string[] {
		return textsOf(".rendered-diff del.md-word-delete");
	}

	/** The text of every ins word mark in the rendered view, topmost first. */
	renderedWordAdded(): string[] {
		return textsOf(".rendered-diff ins.md-word-add");
	}

	/** The text of every list item the rendered view shows, topmost first. */
	renderedListItems(): string[] {
		return textsOf(".rendered-diff li");
	}

	/** The container fold's "N items hidden" notes, topmost first. */
	renderedFoldNotes(): string[] {
		return textsOf(".rendered-diff .rendered-fold");
	}

	/** The rendered blocks still carrying the full background wash. */
	renderedWashed(): Element[] {
		return [
			...document.querySelectorAll(
				".rendered-diff .md-removed:not(.no-wash), .rendered-diff .md-added:not(.no-wash)",
			),
		];
	}
}

function textsOf(selector: string): string[] {
	const blocks = document.querySelectorAll<HTMLElement>(selector);

	return [...blocks].map((block) => block.textContent?.trim() ?? "");
}
