import { waitFor } from "../harness/wait.js";

const SHOW_RENDERED = 'button[title="Show rendered markdown"]';
const SHOW_FULL_FILE = 'button[title="Show full file"]';
const SHOW_SIDE_BY_SIDE = 'button[title="Side-by-side view"]';
const SHOW_INLINE = 'button[title="Inline view"]';
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

	/** Switches the pane from inline to side-by-side, if it is not there already. */
	async showSideBySide(): Promise<void> {
		const button = await waitFor("the layout toggle", () =>
			document.querySelector<HTMLButtonElement>(
				`${SHOW_SIDE_BY_SIDE}, ${SHOW_INLINE}`,
			),
		);

		if (button.matches(SHOW_SIDE_BY_SIDE)) button.click();
	}

	/** The ancestors of the first element matching `selector` that declare a
	 *  vertical scroll container, outermost last. A diff view must have exactly
	 *  one above its content: two give the wheel two places to go on one axis,
	 *  and the inner one, once at its end, chains into the outer and slides the
	 *  pane out of the window (TRUNK-127). An element that sets only
	 *  `overflow-x` is a vertical scroll container too in a real engine, but
	 *  jsdom does not apply that rule, so this reads only declared vertical
	 *  overflow. */
	verticalScrollersAbove(selector: string): string[] {
		const start = document.querySelector(selector);
		if (!start) throw new Error(`no element matches ${selector}`);

		const scrolls = (value: string) => value === "auto" || value === "scroll";
		const found: string[] = [];
		for (let el = start.parentElement; el; el = el.parentElement) {
			const style = getComputedStyle(el);
			const vertical = style.overflowY;
			const shorthand = style.overflow;
			if (
				scrolls(vertical) ||
				((vertical === "" || vertical === "visible") && scrolls(shorthand))
			) {
				found.push(describe(el));
			}
		}
		return found;
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

	/** The text of every rendered block showing no change at all, topmost
	 *  first: no tint on the block and no word mark inside it. This is the
	 *  context around a change, which a renamed file must keep. */
	renderedUnchanged(): string[] {
		const blocks = document.querySelectorAll<HTMLElement>(
			".rendered-diff .rendered-block:not(.md-added):not(.md-removed)",
		);

		return [...blocks]
			.filter((block) => !block.querySelector(".md-word-delete, .md-word-add"))
			.map((block) => (block.textContent ?? "").trim());
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

/** A tag and its classes with the Svelte scope hash removed, so an assertion
 *  failure names the element as its component does. */
function describe(el: Element): string {
	const classes = [...el.classList].filter((c) => !c.startsWith("svelte-"));
	return classes.length > 0
		? `${el.tagName.toLowerCase()}.${classes.join(".")}`
		: el.tagName.toLowerCase();
}
