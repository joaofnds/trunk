import { waitFor } from "../harness/wait.js";

const INLINE_COMMENTS = '[aria-label="Toggle inline comments"]';
const REVIEW = '[aria-label="Review"]';
const HUNK_TOOLBAR = ".hunk-toolbar";
const COMMENT = "Comment";
const COMPOSER_TEXT = ".composer-textarea";
const SUBMIT = ".submit-btn";
const CARD = ".comment-card";
const PROBE = ".comment-probe";
const FILE_REF = ".comment-card-fileref";
const STATE_CHIP = ".thread-state-chip";
const CARD_ACTION = ".card-action";
const PUBLISH = ".publish-button";
const CONFIRM_PUBLISH = "Click again to confirm";
const COPY = ".copy-button";
const MARK_DONE = "Mark done";

/**
 * A review, from the comment that creates it to the doc it renders. Every
 * gesture waits for its control to be enabled before clicking: the composer's
 * Submit is dead until the text is non-empty, and End review and Copy are dead
 * until the review has a comment. jsdom dispatches no click on a disabled
 * button, so a gesture issued early does nothing, quietly.
 */
export class ReviewDriver {
	/** Presses the toolbar's inline-comments toggle. The hunk toolbar renders no
	 *  Comment button at all until it is on, and the pref starts off. */
	async showInlineComments(): Promise<void> {
		const toggle = await waitFor("the inline-comments toggle", () =>
			enabled(INLINE_COMMENTS),
		);

		toggle.click();
	}

	/** Comments the hunk at `ordinal`, topmost first. With no line selection this
	 *  is the whole-hunk affordance. */
	async commentOnHunk(ordinal: number): Promise<void> {
		const button = await waitFor(`${COMMENT} on hunk ${ordinal}`, () =>
			enabledIn(toolbars()[ordinal], COMMENT),
		);

		button.click();
	}

	/** Types into the open composer. */
	async write(text: string): Promise<void> {
		const field = await waitFor("the open composer", () =>
			document.querySelector<HTMLTextAreaElement>(COMPOSER_TEXT),
		);

		field.value = text;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** Submits the composer, which is what sends the comment. */
	async submit(): Promise<void> {
		const button = await waitFor("an enabled submit button", () =>
			enabled(SUBMIT),
		);

		button.click();
	}

	/** Presses the toolbar's Review button, swapping the center pane to the
	 *  review panel. */
	async openPanel(): Promise<void> {
		const button = await waitFor("the review button", () => enabled(REVIEW));

		button.click();
	}

	/** The file each thread card is anchored to, topmost first. */
	threads(): string[] {
		return cards().map((card) => textIn(card, FILE_REF));
	}

	/** The state chip each thread card carries, topmost first. */
	states(): string[] {
		return cards().map((card) => textIn(card, STATE_CHIP));
	}

	/** What the topmost thread card offers the user. */
	actions(): string[] {
		const card = cards()[0];
		if (!card) return [];

		return [...card.querySelectorAll<HTMLElement>(CARD_ACTION)].map(collapse);
	}

	/** Ends the review, which publishes it. Two clicks: the first arms a confirm
	 *  that reverts after 3000 ms, and the second is the one that publishes. */
	async publish(): Promise<void> {
		const button = await waitFor("an enabled end-review button", () =>
			enabled(PUBLISH),
		);

		button.click();

		const confirm = await waitFor("the end-review confirmation", () =>
			collapse(button) === CONFIRM_PUBLISH ? button : null,
		);

		confirm.click();
	}

	/** Takes the topmost thread to `done`, the gesture only a human has. */
	async markDone(): Promise<void> {
		const button = await waitFor(`${MARK_DONE} on the topmost thread`, () =>
			enabledIn(cards()[0], MARK_DONE),
		);

		button.click();
	}

	/** Copies the review doc, which is what renders it. */
	async copyDoc(): Promise<void> {
		const button = await waitFor("an enabled copy button", () => enabled(COPY));

		button.click();
	}
}

function toolbars(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(HUNK_TOOLBAR)];
}

/**
 * The thread cards the user can see. `HunkView` renders every thread a second
 * time inside a hidden probe to measure its height, so a query that names the
 * card alone answers with the probe's copy — and answers it whether or not the
 * panel ever opened.
 */
function cards(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(CARD)].filter(
		(card) => !card.closest(PROBE),
	);
}

function textIn(card: HTMLElement, selector: string): string {
	const node = card.querySelector(selector);

	return node ? collapse(node) : "";
}

function enabled(selector: string): HTMLButtonElement | null {
	const control = document.querySelector<HTMLButtonElement>(selector);

	return control && !control.disabled ? control : null;
}

function enabledIn(
	container: HTMLElement | null | undefined,
	label: string,
): HTMLButtonElement | null {
	if (!container) return null;

	const action = [...container.querySelectorAll("button")].find((button) =>
		collapse(button).startsWith(label),
	);

	return action && !action.disabled ? action : null;
}

function collapse(node: Element): string {
	return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}
